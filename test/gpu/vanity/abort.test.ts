import { afterAll, describe, expect, it, vi } from 'vitest';
import { Ed25519GPU } from '../../../src/index.js';
import { findVanity } from '../../../src/vanity/index.js';

let gpu: Ed25519GPU | null = null;
afterAll(() => { gpu?.destroy(); gpu = null; });
async function getGpu(): Promise<Ed25519GPU> {
    if (!gpu) gpu = await Ed25519GPU.create();
    return gpu;
}

describe('vanity abort', () => {
    it('terminates cleanly when AbortSignal fires at 200ms', async () => {
        const g = await getGpu();
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 200);

        let threw = false;
        try {
            for await (const _ of findVanity(g, { batchSize: 1024, signal: ac.signal })) {
                // drain — no prefix/suffix so no hits expected
            }
        } catch {
            threw = true;
        }

        expect(threw).toBe(false);
        expect(ac.signal.aborted).toBe(true);
    }, 3_000);

    it('leaves no active GPUBuffers after abort', async () => {
        const g = await getGpu();
        const device = (g as any).device as GPUDevice;

        let active = 0;
        const orig = device.createBuffer.bind(device);
        vi.spyOn(device, 'createBuffer').mockImplementation((desc) => {
            const buf = orig(desc);
            active++;
            const origDestroy = buf.destroy.bind(buf);
            buf.destroy = () => { active--; origDestroy(); };
            return buf;
        });

        const ac = new AbortController();
        setTimeout(() => ac.abort(), 200);

        for await (const _ of findVanity(g, { batchSize: 1024, signal: ac.signal })) {
            // drain
        }

        vi.restoreAllMocks();
        expect(active).toBe(0);
    }, 3_000);
});
