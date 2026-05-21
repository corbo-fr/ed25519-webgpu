import { ed25519 } from '@noble/curves/ed25519';
import { afterAll, describe, expect, it } from 'vitest';
import { Ed25519GPU } from '../../../src/index.js';
import { findVanity } from '../../../src/vanity/index.js';

let gpu: Ed25519GPU | null = null;
afterAll(() => { gpu?.destroy(); gpu = null; });
async function getGpu(): Promise<Ed25519GPU> {
    if (!gpu) gpu = await Ed25519GPU.create();
    return gpu;
}

describe('vanity onProgress', () => {
    it('is called with strictly increasing counts', async () => {
        const g = await getGpu();
        const counts: number[] = [];
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 500);

        for await (const _ of findVanity(g, {
            batchSize: 1024,
            signal: ac.signal,
            onProgress: (n) => counts.push(n),
        })) { /* no prefix/suffix — drain all hits */ }

        expect(counts.length).toBeGreaterThan(0);
        for (let i = 1; i < counts.length; i++) {
            expect(counts[i]).toBeGreaterThan(counts[i - 1]);
        }
    }, 3_000);

    it('reported count is a multiple of batchSize', async () => {
        const g = await getGpu();
        const counts: number[] = [];
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 300);

        for await (const _ of findVanity(g, {
            batchSize: 512,
            signal: ac.signal,
            onProgress: (n) => counts.push(n),
        })) { /* drain */ }

        for (const n of counts) {
            expect(n % 512).toBe(0);
        }
    }, 3_000);
});

describe('vanity multi-hit', () => {
    it('generator yields at least 3 hits for prefix "a", all noble-confirmed', async () => {
        const g = await getGpu();
        const hits = [];
        const ac = new AbortController();

        for await (const hit of findVanity(g, { prefix: 'a', batchSize: 1024, signal: ac.signal })) {
            hits.push(hit);
            if (hits.length >= 3) { ac.abort(); break; }
        }

        expect(hits.length).toBe(3);
        for (const hit of hits) {
            expect(hit.address.startsWith('a')).toBe(true);
            const expected = ed25519.getPublicKey(hit.seed);
            expect(hit.publicKey).toEqual(expected);
        }
    }, 30_000);

    it('generator yields at least 3 hits for suffix "z", all noble-confirmed', async () => {
        const g = await getGpu();
        const hits = [];
        const ac = new AbortController();

        for await (const hit of findVanity(g, { suffix: 'z', batchSize: 1024, signal: ac.signal })) {
            hits.push(hit);
            if (hits.length >= 3) { ac.abort(); break; }
        }

        expect(hits.length).toBe(3);
        for (const hit of hits) {
            expect(hit.address.endsWith('z')).toBe(true);
            const expected = ed25519.getPublicKey(hit.seed);
            expect(hit.publicKey).toEqual(expected);
        }
    }, 30_000);
});
