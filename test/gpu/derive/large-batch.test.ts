import { ed25519 } from '@noble/curves/ed25519';
import { afterAll, describe, expect, it } from 'vitest';
import { Ed25519GPU } from '../../../src/index.js';

let gpu: Ed25519GPU | null = null;
afterAll(() => { gpu?.destroy(); gpu = null; });
async function getGpu(): Promise<Ed25519GPU> {
    if (!gpu) gpu = await Ed25519GPU.create();
    return gpu;
}

describe('derivePublicKeys — large batch (65 536 seeds)', () => {
    it('returns 65 536 results, spot-checks 10 against noble', async () => {
        const g = await getGpu();
        const seeds = Array.from({ length: 65_536 }, () => {
            const s = new Uint8Array(32);
            crypto.getRandomValues(s);
            return s;
        });

        const pubkeys = await g.derivePublicKeys(seeds);
        expect(pubkeys).toHaveLength(65_536);

        const indices = Array.from({ length: 10 }, () => Math.floor(Math.random() * 65_536));
        for (const i of indices) {
            const expected = ed25519.getPublicKey(seeds[i]);
            expect(pubkeys[i], `seed index ${i}`).toEqual(expected);
        }
    }, 120_000);
});
