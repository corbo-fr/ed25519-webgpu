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

// Hex chars that are also valid base58 ('a'-'f' and 'A'-'F' are all in the base58 alphabet).
// '0' is invalid base58, so prefix '00' cannot be passed to findVanity directly.
// Instead we search for 'ab' (first pubkey byte === 0xAB), which proves both that the
// custom encoder is called and that prefix filtering operates on its output.
const hexEncode = (pk: Uint8Array) => Buffer.from(pk).toString('hex');

describe('findVanity — custom encodeAddress (hex)', () => {
    it('hit address is hex-encoded and starts with the requested prefix', async () => {
        const g = await getGpu();
        const gen = findVanity(g, { encodeAddress: hexEncode, prefix: 'ab', batchSize: 256 });
        const { value: hit } = await gen.next();
        expect(hit).toBeDefined();
        expect(hit!.address.startsWith('ab')).toBe(true);
        expect(hit!.address).toMatch(/^[0-9a-f]{64}$/);
        const expected = ed25519.getPublicKey(hit!.seed);
        expect(hit!.publicKey).toEqual(expected);
    }, 30_000);
});
