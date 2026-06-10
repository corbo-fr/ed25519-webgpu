import type { Ed25519GPU } from '../index.js';
import { computePrefixBounds, computeSuffixParams } from './bounds.js';
import { encodePrefix, encodeSuffix, matches } from './matcher.js';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
    const digits: number[] = [0];
    for (let i = 0; i < bytes.length; i++) {
        let carry = bytes[i];
        for (let j = 0; j < digits.length; j++) {
            carry += digits[j] << 8;
            digits[j] = carry % 58;
            carry = (carry / 58) | 0;
        }
        while (carry > 0) {
            digits.push(carry % 58);
            carry = (carry / 58) | 0;
        }
    }
    let result = '';
    for (let i = 0; i < bytes.length && bytes[i] === 0; i++) result += '1';
    for (let i = digits.length - 1; i >= 0; i--) result += BASE58_ALPHABET[digits[i]];
    return result;
}


/** A keypair whose address matches the requested pattern. */
export type VanityHit = {
    /** Raw 32-byte seed (Ed25519 private key). */
    seed: Uint8Array;
    /** Compressed 32-byte Ed25519 public key. */
    publicKey: Uint8Array;
    /** Encoded public key (base58 by default). */
    address: string;
};

export type VanityOptions = {
    /** Required address prefix (base58 characters only). */
    prefix?: string;
    /** Required address suffix (base58 characters only). */
    suffix?: string;
    /** Whether prefix/suffix matching is case-sensitive. Default: true. */
    caseSensitive?: boolean;
    /**
     * Number of random keypairs generated per GPU batch. Default: 65536.
     * Pass `'auto'` to let the library probe the GPU and pick the optimal size
     * (calls `gpu.calibrateBatchSize()` once before the first batch).
     */
    batchSize?: number | 'auto';
    /** Pass an AbortController signal to stop the search. */
    signal?: AbortSignal;
    /** Called after each batch with the cumulative number of keys checked. */
    onProgress?: (keysChecked: number) => void;
    /**
     * Custom address encoder. Receives a 32-byte public key, returns an address string.
     * Defaults to base58 (Solana). Override for Stellar (base32), TON, etc.
     */
    encodeAddress?: (pubkey: Uint8Array) => string;
};

/**
 * Races a GPU vanity finder against a user-supplied async generator (e.g. a WASM
 * SIMD CPU backend in a Web Worker). Yields hits from whichever backend finds
 * them first; both run concurrently and stop when the caller aborts or either
 * generator exhausts.
 *
 * @example
 * const cpuGen = cpuWorkerAsAsyncGenerator();
 * const ctl = new AbortController();
 * for await (const hit of findVanityRace(gpu, cpuGen, { prefix: 'ABC', signal: ctl.signal })) {
 *   ctl.abort(); // stop after first hit
 *   console.log(hit);
 * }
 */
export async function* findVanityRace(
    gpu: Ed25519GPU,
    cpuGen: AsyncGenerator<VanityHit>,
    opts: VanityOptions = {},
): AsyncGenerator<VanityHit> {
    const ctl = new AbortController();
    const { signal, ...rest } = opts;
    if (signal?.aborted) return;
    signal?.addEventListener('abort', () => ctl.abort(), { once: true });

    const gpuGen = findVanity(gpu, { ...rest, signal: ctl.signal });

    type Tagged = { src: 'gpu' | 'cpu'; res: IteratorResult<VanityHit> };
    const tagGpu = (res: IteratorResult<VanityHit>): Tagged => ({ src: 'gpu', res });
    const tagCpu = (res: IteratorResult<VanityHit>): Tagged => ({ src: 'cpu', res });

    let gpuP: Promise<Tagged> | null = gpuGen.next().then(tagGpu);
    let cpuP: Promise<Tagged> | null = cpuGen.next().then(tagCpu);

    try {
        while (gpuP !== null || cpuP !== null) {
            if (ctl.signal.aborted) break;
            const candidates = [gpuP, cpuP].filter((p): p is Promise<Tagged> => p !== null);
            const { src, res } = await Promise.race(candidates);
            if (res.done) {
                if (src === 'gpu') gpuP = null;
                else cpuP = null;
            } else {
                yield res.value;
                if (src === 'gpu') gpuP = gpuGen.next().then(tagGpu);
                else cpuP = cpuGen.next().then(tagCpu);
            }
        }
    } finally {
        ctl.abort();
        // Await GPU cleanup so GPU buffers are properly unmapped before this generator terminates.
        await gpuGen.return?.(undefined);
        cpuGen.return?.(undefined);
    }
}

/**
 * Async generator that yields keypairs whose address matches the given prefix/suffix.
 * Runs indefinitely until aborted via `signal` or the generator is returned/thrown.
 *
 * @example
 * const gpu = await Ed25519GPU.create();
 * const controller = new AbortController();
 * for await (const hit of findVanity(gpu, { prefix: 'ABC', signal: controller.signal })) {
 *   console.log(hit.address, hit.seed);
 * }
 */
export async function* findVanity(
    gpu: Ed25519GPU,
    opts: VanityOptions = {},
): AsyncGenerator<VanityHit> {
    const {
        prefix,
        suffix,
        caseSensitive = true,
        batchSize: batchSizeOpt = 65536,
        signal,
        onProgress,
        encodeAddress = base58Encode,
    } = opts;

    const batchSize = batchSizeOpt === 'auto'
        ? await gpu.calibrateBatchSize()
        : batchSizeOpt;

    const prefixBytes = prefix ? encodePrefix(prefix) : undefined;
    const suffixBytes = suffix ? encodeSuffix(suffix) : undefined;

    // GPU vanity filter is only valid for the default base58 encoder, case-sensitive.
    const useGpuFilter =
        encodeAddress === base58Encode &&
        caseSensitive &&
        (prefix !== undefined || suffix !== undefined);

    const bounds      = useGpuFilter && prefix ? computePrefixBounds(prefix) : null;
    // GPU suffix filter is only safe for ≤4 chars (bigint_mod_u32 two-step shift handles m up to 58^4).
    const suffixP     = useGpuFilter && suffix ? computeSuffixParams(suffix) : null;
    const canGpuPrefix = bounds !== null;
    const canGpuSuffix = suffixP !== null;
    const activeGpuFilter = useGpuFilter && (canGpuPrefix || canGpuSuffix);

    // CPU suffix pre-filter: for any suffix length, compute pubkey_be mod 58^k == val directly.
    // 32 byte-by-byte iterations instead of a full O(n²) base58 encode — ~300× faster.
    // Used in the FALLBACK path to skip base58 encoding for non-matching keys.
    let cpuSuffixMod = 0;
    let cpuSuffixVal = 0;
    if (!canGpuSuffix && suffix && encodeAddress === base58Encode && caseSensitive) {
        let mod = 1;
        let val = 0;
        for (const c of suffix) {
            mod *= 58;
            val = val * 58 + BASE58_ALPHABET.indexOf(c);
        }
        cpuSuffixMod = mod;
        cpuSuffixVal = val;
    }

    // Default empty L/H (all zeros / all max) used when the respective filter is off.
    const ZERO_U32 = new Uint32Array(8);
    const MAX_U32  = new Uint32Array(8).fill(0xFFFFFFFF);

    let keysChecked = 0;

    // Web Crypto limits getRandomValues to 64KB per call; fill 2MB in 32 chunks.
    const seedsFlat = new Uint8Array(batchSize * 32);
    const CRYPTO_CHUNK = 65536;

    while (!signal?.aborted) {
        for (let off = 0; off < seedsFlat.byteLength; off += CRYPTO_CHUNK) {
            crypto.getRandomValues(seedsFlat.subarray(off, Math.min(off + CRYPTO_CHUNK, seedsFlat.byteLength)));
        }

        if (activeGpuFilter) {
            // GPU vanity path: only hit seeds are returned, CPU re-verifies each.
            const hitSeeds = await (gpu as any)._vanityBatch(seedsFlat, {
                L: bounds?.L ?? ZERO_U32,
                H: bounds?.H ?? MAX_U32,
                hasPrefix: canGpuPrefix,
                suffixMod: suffixP?.mod ?? 0,
                suffixVal: suffixP?.val ?? 0,
                hasSuffix: canGpuSuffix,
            });

            if (signal?.aborted) break;

            if (hitSeeds.length > 0) {
                // Re-derive pubkeys for hit seeds (GPU pipeline, correct by construction).
                const pubkeys = await gpu.derivePublicKeys(hitSeeds);

                if (signal?.aborted) break;

                for (let i = 0; i < hitSeeds.length; i++) {
                    const address = encodeAddress(pubkeys[i]);
                    if (matches(address, prefixBytes, suffixBytes, caseSensitive)) {
                        yield { seed: hitSeeds[i], publicKey: pubkeys[i], address };
                    }
                }
            }
        } else {
            // Fallback: full derive + CPU matching (no filter, custom encoder, case-insensitive…).
            const seedViews = Array.from({ length: batchSize }, (_, i) =>
                seedsFlat.subarray(i * 32, i * 32 + 32)
            );
            const pubkeys = await gpu.derivePublicKeys(seedViews);

            if (signal?.aborted) break;

            for (let i = 0; i < batchSize; i++) {
                // Fast CPU suffix pre-filter: skip base58 encode for obvious mismatches.
                if (cpuSuffixMod !== 0) {
                    let rem = 0;
                    const pk = pubkeys[i];
                    for (let b = 0; b < 32; b++) rem = (rem * 256 + pk[b]) % cpuSuffixMod;
                    if (rem !== cpuSuffixVal) continue;
                }
                const address = encodeAddress(pubkeys[i]);
                if (matches(address, prefixBytes, suffixBytes, caseSensitive)) {
                    yield { seed: seedViews[i], publicKey: pubkeys[i], address };
                }
            }
        }

        keysChecked += batchSize;
        onProgress?.(keysChecked);
    }
}
