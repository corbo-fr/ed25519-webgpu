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

describe('findVanity — case-insensitive GPU flow', () => {
    it('prefix "A" with caseSensitive:false matches address starting with "a" or "A"', async () => {
        const g = await getGpu();
        const gen = findVanity(g, { prefix: 'A', caseSensitive: false, batchSize: 1024 });
        const { value: hit } = await gen.next();
        expect(hit).toBeDefined();
        expect(hit!.address.toLowerCase().startsWith('a')).toBe(true);
        const expected = ed25519.getPublicKey(hit!.seed);
        expect(hit!.publicKey).toEqual(expected);
    }, 3_000);
});
