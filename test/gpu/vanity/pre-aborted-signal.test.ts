import { afterAll, describe, expect, it } from 'vitest';
import { Ed25519GPU } from '../../../src/index.js';
import { findVanity } from '../../../src/vanity/index.js';

let gpu: Ed25519GPU | null = null;
afterAll(() => { gpu?.destroy(); gpu = null; });
async function getGpu(): Promise<Ed25519GPU> {
    if (!gpu) gpu = await Ed25519GPU.create();
    return gpu;
}

describe('findVanity — pre-aborted signal', () => {
    it('first .next() resolves { value: undefined, done: true } without GPU work', async () => {
        const g = await getGpu();
        const ac = new AbortController();
        ac.abort();

        const gen = findVanity(g, { signal: ac.signal });
        const result = await gen.next();
        expect(result.done).toBe(true);
        expect(result.value).toBeUndefined();
    }, 3_000);
});
