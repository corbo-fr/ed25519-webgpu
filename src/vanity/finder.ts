import type { Ed25519GPU } from '../index.js';
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

function yieldControl(): Promise<void> {
    if (typeof requestAnimationFrame !== 'undefined') {
        return new Promise(resolve => requestAnimationFrame(() => resolve()));
    }
    return new Promise(resolve => setTimeout(resolve, 0));
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
    /** Number of random keypairs generated per GPU batch. Default: 1024. */
    batchSize?: number;
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
        batchSize = 1024,
        signal,
        onProgress,
        encodeAddress = base58Encode,
    } = opts;

    const prefixBytes = prefix ? encodePrefix(prefix) : undefined;
    const suffixBytes = suffix ? encodeSuffix(suffix) : undefined;

    let keysChecked = 0;

    while (!signal?.aborted) {
        const seeds: Uint8Array[] = Array.from({ length: batchSize }, () =>
            crypto.getRandomValues(new Uint8Array(32))
        );

        const pubkeys = await gpu.derivePublicKeys(seeds);

        if (signal?.aborted) break;

        for (let i = 0; i < batchSize; i++) {
            const address = encodeAddress(pubkeys[i]);
            if (matches(address, prefixBytes, suffixBytes, caseSensitive)) {
                yield { seed: seeds[i], publicKey: pubkeys[i], address };
            }
        }

        keysChecked += batchSize;
        onProgress?.(keysChecked);

        await yieldControl();
    }
}
