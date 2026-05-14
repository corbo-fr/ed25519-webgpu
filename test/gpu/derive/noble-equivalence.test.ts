import { ed25519 } from '@noble/curves/ed25519';
import { afterAll, describe, expect, it } from 'vitest';
import { Ed25519GPU } from '../../../src/index.js';

let gpu: Ed25519GPU | null = null;
afterAll(() => { gpu?.destroy(); gpu = null; });
async function getGpu(): Promise<Ed25519GPU> {
    if (!gpu) gpu = await Ed25519GPU.create();
    return gpu;
}

function randomSeeds(n: number): Uint8Array[] {
    return Array.from({ length: n }, () => {
        const s = new Uint8Array(32);
        crypto.getRandomValues(s);
        return s;
    });
}

describe('noble equivalence — 1000 random seeds', () => {
    it('100% match ed25519.getPublicKey', async () => {
        const seeds   = randomSeeds(1000);
        const g       = await getGpu();
        const pubkeys = await g.derivePublicKeys(seeds);
        for (let i = 0; i < seeds.length; i++) {
            const expected = ed25519.getPublicKey(seeds[i]);
            expect(pubkeys[i], `seed ${i}`).toEqual(expected);
        }
    }, 300_000);
});

describe('noble equivalence — 10 000 random seeds (CI gate)', () => {
    it('100% match ed25519.getPublicKey', async () => {
        const seeds   = randomSeeds(10_000);
        const g       = await getGpu();
        const pubkeys = await g.derivePublicKeys(seeds);
        for (let i = 0; i < seeds.length; i++) {
            const expected = ed25519.getPublicKey(seeds[i]);
            expect(pubkeys[i], `seed ${i}`).toEqual(expected);
        }
    }, 600_000);
});
