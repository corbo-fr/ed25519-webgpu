import { ed25519 } from '@noble/curves/ed25519';
import { afterAll, describe, expect, it } from 'vitest';
import { Ed25519GPU } from '../../../src/index.js';

let gpu: Ed25519GPU | null = null;
afterAll(() => { gpu?.destroy(); gpu = null; });
async function getGpu(): Promise<Ed25519GPU> {
    if (!gpu) gpu = await Ed25519GPU.create();
    return gpu;
}

describe('derivePublicKeys — empty batch', () => {
    it('returns [] without crashing', async () => {
        const g = await getGpu();
        const result = await g.derivePublicKeys([]);
        expect(result).toEqual([]);
    });
});

describe('derivePublicKeys — single seed', () => {
    it('returns one pubkey matching noble', async () => {
        const g = await getGpu();
        const seed = new Uint8Array(32);
        crypto.getRandomValues(seed);
        const result = await g.derivePublicKeys([seed]);
        expect(result).toHaveLength(1);
        const expected = ed25519.getPublicKey(seed);
        expect(result[0]).toEqual(expected);
    });
});
