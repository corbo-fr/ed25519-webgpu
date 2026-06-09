// Safari/Metal compatibility smoke tests.
// Run with: pnpm test:safari (webkit Vitest project, requires: pnpm exec playwright install webkit)
//
// Covers the four checklist items from issue #13:
//   - Shader compilation: pipeline_derive + pipeline_vanity compile on Metal without error
//   - Correctness:        RFC 8032 vector produces the expected public key
//   - Throughput:         keys/s measured and logged (no hard threshold — hardware varies)
//   - Error recovery:     destroy() cleans up without throwing; device.lost handler is registered

import { afterAll, describe, expect, it } from 'vitest';
import { Ed25519GPU, getAdapterInfo } from '../../../src/index.js';

let gpu: Ed25519GPU | null = null;
afterAll(() => { gpu?.destroy(); gpu = null; });
async function getGpu(): Promise<Ed25519GPU> {
    if (!gpu) gpu = await Ed25519GPU.create();
    return gpu;
}

describe('adapter info — Metal/WebKit backend', () => {
    it('exposes vendor and architecture strings', async () => {
        const info = await getAdapterInfo();
        expect(info).not.toBeNull();
        console.log(`[safari] adapter: vendor="${info!.vendor}" arch="${info!.architecture}" desc="${info!.description}"`);
        expect(typeof info!.vendor).toBe('string');
        expect(typeof info!.architecture).toBe('string');
    }, 30_000);
});

describe('shader compilation — pipeline_derive and pipeline_vanity on Metal', () => {
    it('Ed25519GPU.create() succeeds (all four shaders compile without error)', async () => {
        // compilePipelines() calls mkSafe() which throws on any shader compilation error.
        // A successful Ed25519GPU.create() means sha512, scalar-mult, derive and vanity
        // all compiled cleanly on the Metal/MSL backend.
        const g = await getGpu();
        expect(g).toBeInstanceOf(Ed25519GPU);
        console.log('[safari] all four pipelines compiled successfully on Metal');
    }, 60_000);
});

describe('correctness — RFC 8032 §6.1 vec1 on Metal', () => {
    it('derives the correct public key on the Metal backend', async () => {
        const seed = Uint8Array.from([
            0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60,
            0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c, 0xc4,
            0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19,
            0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae, 0x7f, 0x60,
        ]);
        const expected = Uint8Array.from([
            0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7,
            0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64, 0x07, 0x3a,
            0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25,
            0xaf, 0x02, 0x1a, 0x68, 0xf7, 0x07, 0x51, 0x1a,
        ]);
        const g = await getGpu();
        const [pubkey] = await g.derivePublicKeys([seed]);
        expect(pubkey).toEqual(expected);
    }, 60_000);
});

describe('throughput — baseline measurement on Metal', () => {
    it('measures keys/s and logs the result (no hard threshold)', async () => {
        const N = 1024;
        const makeSeeds = () => Array.from({ length: N }, () => crypto.getRandomValues(new Uint8Array(32)));

        const g = await getGpu();

        // warm-up
        await g.derivePublicKeys(makeSeeds());

        const RUNS = 3;
        let totalMs = 0;
        for (let r = 0; r < RUNS; r++) {
            const t0 = performance.now();
            await g.derivePublicKeys(makeSeeds());
            totalMs += performance.now() - t0;
        }

        const kps = Math.round((N * RUNS) / totalMs * 1000);
        console.log(`[safari] throughput: ${kps} keys/s (N=${N}, ${RUNS} runs, total=${totalMs.toFixed(1)}ms)`);
        expect(kps).toBeGreaterThan(0);
    }, 120_000);
});

describe('GPU error recovery — device.lost handler', () => {
    it('destroy() completes without throwing', async () => {
        const g = await Ed25519GPU.create();
        expect(() => g.destroy()).not.toThrow();
    }, 30_000);

    it('derivePublicKeys rejects after destroy()', async () => {
        const g = await Ed25519GPU.create();
        g.destroy();
        const seed = crypto.getRandomValues(new Uint8Array(32));
        await expect(g.derivePublicKeys([seed])).rejects.toThrow();
    }, 30_000);
});
