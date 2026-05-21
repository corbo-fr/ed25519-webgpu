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

describe('vanity prefix "a" + suffix "z"', () => {
    it('finds a hit in < 30s and noble confirms the pubkey', async () => {
        const g = await getGpu();
        const gen = findVanity(g, { prefix: 'a', suffix: 'z', batchSize: 1024 });
        const { value: hit } = await gen.next();
        expect(hit).toBeDefined();
        expect(hit!.address.startsWith('a')).toBe(true);
        expect(hit!.address.endsWith('z')).toBe(true);
        const expected = ed25519.getPublicKey(hit!.seed);
        expect(hit!.publicKey).toEqual(expected);
    }, 30_000);
});

describe('vanity prefix "1" + suffix "1"', () => {
    it('finds a hit in < 30s and noble confirms the pubkey', async () => {
        const g = await getGpu();
        const gen = findVanity(g, { prefix: '1', suffix: '1', batchSize: 1024 });
        const { value: hit } = await gen.next();
        expect(hit).toBeDefined();
        expect(hit!.address.startsWith('1')).toBe(true);
        expect(hit!.address.endsWith('1')).toBe(true);
        const expected = ed25519.getPublicKey(hit!.seed);
        expect(hit!.publicKey).toEqual(expected);
    }, 30_000);
});
