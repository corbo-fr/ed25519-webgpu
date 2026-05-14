import { ed25519 } from '@noble/curves/ed25519';
import { afterAll, describe, expect, it } from 'vitest';
import { Ed25519GPU } from '../../../src/index.js';

let gpu: Ed25519GPU | null = null;
afterAll(() => { gpu?.destroy(); gpu = null; });
async function getGpu(): Promise<Ed25519GPU> {
    if (!gpu) gpu = await Ed25519GPU.create();
    return gpu;
}

const EDGE_SEEDS: { label: string; seed: Uint8Array }[] = [
    { label: 'all-zero',    seed: new Uint8Array(32).fill(0x00) },
    { label: 'all-0xFF',    seed: new Uint8Array(32).fill(0xFF) },
    { label: 'all-0x01',    seed: new Uint8Array(32).fill(0x01) },
    { label: 'alternating', seed: Uint8Array.from({ length: 32 }, (_, i) => i % 2 === 0 ? 0xAA : 0x55) },
];

describe('edge seeds — match noble', () => {
    it('all edge seeds produce correct public keys', async () => {
        const g      = await getGpu();
        const seeds  = EDGE_SEEDS.map(e => e.seed);
        const pubkeys = await g.derivePublicKeys(seeds);
        for (let i = 0; i < EDGE_SEEDS.length; i++) {
            const expected = ed25519.getPublicKey(seeds[i]);
            expect(pubkeys[i], EDGE_SEEDS[i].label).toEqual(expected);
        }
    }, 120_000);
});
