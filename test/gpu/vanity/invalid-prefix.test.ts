import { afterAll, describe, expect, it } from 'vitest';
import { Ed25519GPU } from '../../../src/index.js';
import { findVanity } from '../../../src/vanity/index.js';

let gpu: Ed25519GPU | null = null;
afterAll(() => { gpu?.destroy(); gpu = null; });
async function getGpu(): Promise<Ed25519GPU> {
    if (!gpu) gpu = await Ed25519GPU.create();
    return gpu;
}

describe('findVanity — invalid base58 chars', () => {
    it('rejects on first .next() when prefix contains "0"', async () => {
        const g = await getGpu();
        const gen = findVanity(g, { prefix: '0abc' });
        await expect(gen.next()).rejects.toThrow();
    });

    it('rejects on first .next() when suffix contains "l"', async () => {
        const g = await getGpu();
        const gen = findVanity(g, { suffix: 'lll' });
        await expect(gen.next()).rejects.toThrow();
    });

    it('rejects on first .next() when prefix contains "I"', async () => {
        const g = await getGpu();
        const gen = findVanity(g, { prefix: 'I' });
        await expect(gen.next()).rejects.toThrow();
    });
});
