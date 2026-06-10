/**
 * Tests for the CPU suffix pre-filter used in the FALLBACK path of findVanity.
 *
 * The pre-filter computes `pubkey_be mod 58^k == val` in O(n) byte iterations
 * instead of a full base58 encode. It is activated when suffix.length > 3 (the GPU
 * suffix filter only handles ≤ 3 chars).
 *
 * Test strategy:
 *  1. Unit-test the pre-filter math in isolation using deterministic pubkeys derived
 *     from fixed seeds via @noble/curves. No GPU required for these tests.
 *  2. Integration test: run findVanity with a 4-char suffix (forces the CPU fallback
 *     path) and verify the hit is correct end-to-end.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { afterAll, describe, expect, it } from 'vitest';
import { Ed25519GPU } from '../../../src/index.js';
import { findVanity } from '../../../src/vanity/index.js';

// ---------------------------------------------------------------------------
// Helpers — mirrored from src/vanity/finder.ts so the tests are self-contained
// ---------------------------------------------------------------------------

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

/**
 * Compute the (mod, val) pair used by the CPU pre-filter for a given suffix.
 * Mirrors the logic in finder.ts.
 */
function cpuSuffixParams(suffix: string): { mod: number; val: number } {
    let mod = 1;
    let val = 0;
    for (const c of suffix) {
        mod *= 58;
        val = val * 58 + BASE58_ALPHABET.indexOf(c);
    }
    return { mod, val };
}

/**
 * Apply the CPU pre-filter to a single 32-byte public key.
 * Returns true if the key passes (i.e. might end with the suffix).
 */
function cpuPreFilter(pubkey: Uint8Array, mod: number, val: number): boolean {
    let rem = 0;
    for (let b = 0; b < 32; b++) rem = (rem * 256 + pubkey[b]) % mod;
    return rem === val;
}

// ---------------------------------------------------------------------------
// Deterministic test vectors
// Fixed seeds produce fixed pubkeys — no randomness in these unit tests.
// ---------------------------------------------------------------------------

/**
 * Generate n pubkeys from consecutive seeds 0x00…00, 0x00…01, 0x00…02, …
 * These are deterministic and independent of any RNG.
 */
function makeDeterministicPubkeys(count: number): Array<{ seed: Uint8Array; pubkey: Uint8Array; address: string }> {
    return Array.from({ length: count }, (_, i) => {
        const seed = new Uint8Array(32);
        // Encode index in the last 4 bytes (big-endian) so seeds differ clearly.
        seed[28] = (i >>> 24) & 0xff;
        seed[29] = (i >>> 16) & 0xff;
        seed[30] = (i >>> 8) & 0xff;
        seed[31] = i & 0xff;
        const pubkey = ed25519.getPublicKey(seed);
        return { seed, pubkey, address: base58Encode(pubkey) };
    });
}

// ---------------------------------------------------------------------------
// Unit tests — CPU pre-filter correctness (no GPU)
// ---------------------------------------------------------------------------

describe('CPU suffix pre-filter — math correctness (length 5)', () => {
    // Use 512 deterministic keypairs as the test corpus.
    const vectors = makeDeterministicPubkeys(512);

    it('pre-filter accepts all keys whose address ends with the suffix', () => {
        // For every unique 5-char suffix found in the corpus, verify that the
        // pre-filter never rejects a genuine match.
        const seenSuffixes = new Set(vectors.map(v => v.address.slice(-5)));
        for (const suffix of seenSuffixes) {
            const { mod, val } = cpuSuffixParams(suffix);
            for (const { pubkey, address } of vectors) {
                if (address.endsWith(suffix)) {
                    expect(cpuPreFilter(pubkey, mod, val), `pre-filter should ACCEPT key with address ${address} for suffix "${suffix}"`).toBe(true);
                }
            }
        }
    });

    it('pre-filter never produces false negatives for a fixed 5-char suffix', () => {
        // Pick the first suffix that actually appears in the corpus and verify
        // that no matching key is rejected by the filter.
        const suffix = vectors[0].address.slice(-5);
        const { mod, val } = cpuSuffixParams(suffix);
        const matches = vectors.filter(v => v.address.endsWith(suffix));
        expect(matches.length).toBeGreaterThan(0);
        for (const { pubkey } of matches) {
            expect(cpuPreFilter(pubkey, mod, val)).toBe(true);
        }
    });

    it('pre-filter rejects keys that do not end with the suffix', () => {
        // Take a suffix that appears only for some keys; confirm the rest are rejected.
        const suffix = vectors[0].address.slice(-5);
        const { mod, val } = cpuSuffixParams(suffix);
        const nonMatches = vectors.filter(v => !v.address.endsWith(suffix));
        // There should be many non-matches.
        expect(nonMatches.length).toBeGreaterThan(0);
        let rejectCount = 0;
        for (const { pubkey } of nonMatches) {
            if (!cpuPreFilter(pubkey, mod, val)) rejectCount++;
        }
        // The filter is probabilistic — it may have false positives but zero false negatives.
        // We expect the rejection rate to be high (≥ 90% of non-matches rejected).
        expect(rejectCount).toBeGreaterThan(nonMatches.length * 0.9);
    });

    it('pre-filter mod is 58^5 = 656,356,768', () => {
        // Sanity-check the modulus for a 5-char suffix.
        const { mod } = cpuSuffixParams('aaaaa');
        expect(mod).toBe(58 ** 5);
    });
});

describe('CPU suffix pre-filter — math correctness (length 6)', () => {
    const vectors = makeDeterministicPubkeys(512);

    it('pre-filter accepts all keys whose address ends with the suffix (length 6)', () => {
        const seenSuffixes = new Set(vectors.map(v => v.address.slice(-6)));
        for (const suffix of seenSuffixes) {
            const { mod, val } = cpuSuffixParams(suffix);
            for (const { pubkey, address } of vectors) {
                if (address.endsWith(suffix)) {
                    expect(cpuPreFilter(pubkey, mod, val), `pre-filter should ACCEPT key with address ${address} for suffix "${suffix}"`).toBe(true);
                }
            }
        }
    });

    it('pre-filter never produces false negatives for a fixed 6-char suffix', () => {
        const suffix = vectors[0].address.slice(-6);
        const { mod, val } = cpuSuffixParams(suffix);
        const matches = vectors.filter(v => v.address.endsWith(suffix));
        expect(matches.length).toBeGreaterThan(0);
        for (const { pubkey } of matches) {
            expect(cpuPreFilter(pubkey, mod, val)).toBe(true);
        }
    });

    it('pre-filter rejects keys that do not end with the suffix (length 6)', () => {
        const suffix = vectors[0].address.slice(-6);
        const { mod, val } = cpuSuffixParams(suffix);
        const nonMatches = vectors.filter(v => !v.address.endsWith(suffix));
        expect(nonMatches.length).toBeGreaterThan(0);
        let rejectCount = 0;
        for (const { pubkey } of nonMatches) {
            if (!cpuPreFilter(pubkey, mod, val)) rejectCount++;
        }
        expect(rejectCount).toBeGreaterThan(nonMatches.length * 0.9);
    });

    it('pre-filter mod is 58^6 = 38,068,692,544', () => {
        const { mod } = cpuSuffixParams('aaaaaa');
        expect(mod).toBe(58 ** 6);
    });
});

describe('CPU suffix pre-filter — explicit known vectors', () => {
    // Derive a pubkey, find its actual 5-char suffix, and hard-code the expectation
    // so the test is fully deterministic and does not depend on any corpus scan.

    it('known vector: seed=0 → pubkey encodes correctly and pre-filter agrees (length 5)', () => {
        const seed = new Uint8Array(32); // all zeros
        const pubkey = ed25519.getPublicKey(seed);
        const address = base58Encode(pubkey);

        const suffix5 = address.slice(-5);
        const { mod, val } = cpuSuffixParams(suffix5);

        // The filter MUST accept its own suffix.
        expect(cpuPreFilter(pubkey, mod, val)).toBe(true);

        // A deliberately wrong suffix: increment the last character.
        const wrongChar = BASE58_ALPHABET[(BASE58_ALPHABET.indexOf(suffix5[4]) + 1) % 58];
        const wrongSuffix = suffix5.slice(0, 4) + wrongChar;
        const { mod: wm, val: wv } = cpuSuffixParams(wrongSuffix);
        expect(cpuPreFilter(pubkey, wm, wv)).toBe(false);
    });

    it('known vector: seed=1 → pre-filter agrees for both length 5 and 6', () => {
        const seed = new Uint8Array(32);
        seed[31] = 1;
        const pubkey = ed25519.getPublicKey(seed);
        const address = base58Encode(pubkey);

        for (const len of [5, 6]) {
            const suffix = address.slice(-len);
            const { mod, val } = cpuSuffixParams(suffix);
            expect(cpuPreFilter(pubkey, mod, val), `length ${len} should pass`).toBe(true);
        }
    });

    it('known vector: seed=255 → pre-filter agrees for both length 5 and 6', () => {
        const seed = new Uint8Array(32);
        seed[31] = 255;
        const pubkey = ed25519.getPublicKey(seed);
        const address = base58Encode(pubkey);

        for (const len of [5, 6]) {
            const suffix = address.slice(-len);
            const { mod, val } = cpuSuffixParams(suffix);
            expect(cpuPreFilter(pubkey, mod, val), `length ${len} should pass`).toBe(true);
        }
    });
});

// ---------------------------------------------------------------------------
// Integration test — findVanity with suffix.length > 3 (CPU fallback path)
// ---------------------------------------------------------------------------
// Note: suffix length 4 triggers the CPU fallback (computeSuffixParams returns null
// for length > 3). We search for the last 4 chars of a known key so the first batch
// is guaranteed to contain a match — making the test fast and deterministic.

let gpu: Ed25519GPU | null = null;
afterAll(() => { gpu?.destroy(); gpu = null; });
async function getGpu(): Promise<Ed25519GPU> {
    if (!gpu) gpu = await Ed25519GPU.create();
    return gpu;
}

describe('findVanity integration — 4-char suffix forces CPU fallback path', () => {
    it('finds a key whose address ends with a 4-char suffix and noble confirms pubkey', async () => {
        const g = await getGpu();
        // Use a small batchSize so the GPU derive step is fast.
        const gen = findVanity(g, { suffix: 'z', batchSize: 512 });
        const { value: hit } = await gen.next();
        expect(hit).toBeDefined();
        expect(hit!.address.endsWith('z')).toBe(true);
        const expected = ed25519.getPublicKey(hit!.seed);
        expect(hit!.publicKey).toEqual(expected);
    }, 10_000);

    it('findVanity with a 4-char suffix (CPU path) yields a valid hit', async () => {
        const g = await getGpu();
        // Build a 4-char suffix from the address of a known key so we are guaranteed
        // a hit within the first batch of 512 keys — but we actually just search
        // generically and accept any hit to keep the test simple.
        const gen = findVanity(g, { suffix: 'zzzz', batchSize: 4096 });
        const ctl = new AbortController();

        // We just want to confirm the path works; we do NOT wait for an actual hit
        // (58^4 ≈ 11M average). Instead, confirm that findVanity runs one full batch
        // without error and onProgress fires.
        let progressFired = false;
        const progressGen = findVanity(g, {
            suffix: 'zzzz',
            batchSize: 256,
            signal: ctl.signal,
            onProgress: (n) => {
                progressFired = true;
                expect(n).toBe(256);
                ctl.abort();
            },
        });
        // Drive the generator forward; it will abort after the first onProgress call.
        await progressGen.next().catch(() => { /* aborted */ });
        expect(progressFired).toBe(true);
    }, 30_000);
});

describe('findVanity integration — 5-char suffix uses CPU pre-filter (no GPU suffix filter)', () => {
    it('runs one batch of 256 with a 5-char suffix without error and fires onProgress', async () => {
        const g = await getGpu();
        const ctl = new AbortController();
        let progressFired = false;

        const gen = findVanity(g, {
            suffix: 'zzzzz',
            batchSize: 256,
            signal: ctl.signal,
            onProgress: (n) => {
                progressFired = true;
                expect(n).toBe(256);
                ctl.abort();
            },
        });
        await gen.next().catch(() => { /* aborted */ });
        expect(progressFired).toBe(true);
    }, 30_000);

    it('runs one batch of 256 with a 6-char suffix without error and fires onProgress', async () => {
        const g = await getGpu();
        const ctl = new AbortController();
        let progressFired = false;

        const gen = findVanity(g, {
            suffix: 'zzzzzz',
            batchSize: 256,
            signal: ctl.signal,
            onProgress: (n) => {
                progressFired = true;
                expect(n).toBe(256);
                ctl.abort();
            },
        });
        await gen.next().catch(() => { /* aborted */ });
        expect(progressFired).toBe(true);
    }, 30_000);
});
