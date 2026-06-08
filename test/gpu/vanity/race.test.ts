import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ed25519GPU } from '../../../src/index.js';
import { findVanityRace, type VanityHit } from '../../../src/vanity/finder.js';

let gpu: Ed25519GPU;

beforeAll(async () => {
    gpu = await Ed25519GPU.create();
});

afterAll(() => gpu.destroy());

describe('findVanityRace', () => {
    it('yields a hit from the instant CPU generator before the GPU batch completes', async () => {
        const expectedHit: VanityHit = {
            seed: new Uint8Array(32).fill(0x42),
            publicKey: new Uint8Array(32).fill(0x55),
            address: 'CPUHitTest',
        };

        async function* instantCpu(): AsyncGenerator<VanityHit> {
            yield expectedHit;
        }

        const ctl = new AbortController();
        let received: VanityHit | undefined;
        for await (const hit of findVanityRace(gpu, instantCpu(), { signal: ctl.signal })) {
            received = hit;
            break; // break triggers .return() → finally runs → GPU buffers properly unmapped
        }

        expect(received).toBeDefined();
        expect(received!.address).toBe('CPUHitTest');
        expect(received!.seed).toEqual(expectedHit.seed);
    }, 30_000);

    it('stops immediately when pre-aborted signal is passed', async () => {
        const ctl = new AbortController();
        ctl.abort();

        async function* neverYields(): AsyncGenerator<VanityHit> {
            await new Promise<never>(() => { /* never */ });
            yield {} as VanityHit;
        }

        const result = await findVanityRace(gpu, neverYields(), { signal: ctl.signal }).next();
        expect(result.done).toBe(true);
    }, 5_000);

    it('terminates cleanly when CPU generator is empty and signal is aborted', async () => {
        async function* emptyCpu(): AsyncGenerator<VanityHit> { /* yields nothing */ }

        const ctl = new AbortController();
        // Abort after a short delay to let the GPU start one batch.
        // Use a small batchSize to avoid spending seconds on base58 encoding 65k keys.
        setTimeout(() => ctl.abort(), 400);

        const hits: VanityHit[] = [];
        for await (const hit of findVanityRace(gpu, emptyCpu(), {
            signal: ctl.signal,
            batchSize: 128,
        })) {
            hits.push(hit);
        }
        // Generator terminated cleanly after abort — no exception thrown
        expect(Array.isArray(hits)).toBe(true);
    }, 15_000);
});
