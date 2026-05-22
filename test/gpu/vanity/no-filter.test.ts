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

describe('findVanity — no prefix, no suffix', () => {
    it('first .next() returns a defined hit with noble-confirmed pubkey', async () => {
        const g = await getGpu();
        const gen = findVanity(g, { batchSize: 256 });
        const { value: hit } = await gen.next();
        expect(hit).toBeDefined();
        expect(hit!.seed).toBeInstanceOf(Uint8Array);
        expect(hit!.seed).toHaveLength(32);
        expect(hit!.publicKey).toBeInstanceOf(Uint8Array);
        expect(hit!.publicKey).toHaveLength(32);
        expect(hit!.address.length).toBeGreaterThan(0);
        const expected = ed25519.getPublicKey(hit!.seed);
        expect(hit!.publicKey).toEqual(expected);
    }, 5_000);
});
