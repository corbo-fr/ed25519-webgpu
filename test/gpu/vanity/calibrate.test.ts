import { afterAll, describe, expect, it } from 'vitest';
import { Ed25519GPU } from '../../../src/index.js';
import { calibrateBatchSize, findVanity } from '../../../src/vanity/index.js';

const VALID_SIZES = [4096, 16384, 65536, 131072, 262144];

let gpu: Ed25519GPU | null = null;
afterAll(() => { gpu?.destroy(); gpu = null; });
async function getGpu(): Promise<Ed25519GPU> {
    if (!gpu) gpu = await Ed25519GPU.create();
    return gpu;
}

describe('calibrateBatchSize', () => {
    it('returns one of the probed sizes', async () => {
        const g = await getGpu();
        const size = await calibrateBatchSize(g);
        expect(VALID_SIZES).toContain(size);
    }, 60_000);

    it('caches result — second call resolves instantly', async () => {
        const g = await getGpu();
        const t0 = performance.now();
        const size = await calibrateBatchSize(g);
        const elapsed = performance.now() - t0;
        expect(VALID_SIZES).toContain(size);
        expect(elapsed).toBeLessThan(50);
    }, 5_000);

    it('gpu.calibrateBatchSize() and standalone calibrateBatchSize() agree', async () => {
        const g = await getGpu();
        const [fromMethod, fromFn] = await Promise.all([
            g.calibrateBatchSize(),
            calibrateBatchSize(g),
        ]);
        expect(fromFn).toBe(fromMethod);
    }, 5_000);
});

describe("findVanity with batchSize: 'auto'", () => {
    it("resolves auto and finds a hit", async () => {
        const g = await getGpu();
        const gen = findVanity(g, { prefix: 'a', batchSize: 'auto' });
        const { value: hit } = await gen.next();
        await gen.return(undefined);
        expect(hit).toBeDefined();
        expect(hit!.address.startsWith('a')).toBe(true);
    }, 60_000);
});
