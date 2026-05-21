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

describe('vanity caseSensitive: false — prefix', () => {
    it('prefix "A" matches addresses starting with "A" or "a"', async () => {
        const g = await getGpu();
        const gen = findVanity(g, { prefix: 'A', caseSensitive: false, batchSize: 1024 });
        const { value: hit } = await gen.next();
        expect(hit).toBeDefined();
        expect(hit!.address[0].toLowerCase()).toBe('a');
        const expected = ed25519.getPublicKey(hit!.seed);
        expect(hit!.publicKey).toEqual(expected);
    }, 3_000);

    it('prefix "a" matches addresses starting with "a" or "A"', async () => {
        const g = await getGpu();
        const gen = findVanity(g, { prefix: 'a', caseSensitive: false, batchSize: 1024 });
        const { value: hit } = await gen.next();
        expect(hit).toBeDefined();
        expect(hit!.address[0].toLowerCase()).toBe('a');
        const expected = ed25519.getPublicKey(hit!.seed);
        expect(hit!.publicKey).toEqual(expected);
    }, 3_000);
});

describe('vanity caseSensitive: false — suffix', () => {
    it('suffix "Z" matches addresses ending with "Z" or "z"', async () => {
        const g = await getGpu();
        const gen = findVanity(g, { suffix: 'Z', caseSensitive: false, batchSize: 1024 });
        const { value: hit } = await gen.next();
        expect(hit).toBeDefined();
        expect(hit!.address.at(-1)!.toLowerCase()).toBe('z');
        const expected = ed25519.getPublicKey(hit!.seed);
        expect(hit!.publicKey).toEqual(expected);
    }, 3_000);
});

describe('vanity caseSensitive: true (default)', () => {
    it('prefix "A" only matches exact uppercase', async () => {
        const g = await getGpu();
        const gen = findVanity(g, { prefix: 'A', caseSensitive: true, batchSize: 1024 });
        const { value: hit } = await gen.next();
        expect(hit).toBeDefined();
        expect(hit!.address.startsWith('A')).toBe(true);
        const expected = ed25519.getPublicKey(hit!.seed);
        expect(hit!.publicKey).toEqual(expected);
    }, 3_000);
});
