import { createStorageBuffer, readbackBuffer } from './buffers.js';
import type { Pipelines } from './pipelines.js';

const BATCH_SIZE = 65536;

export async function derivePublicKeys(
    device: GPUDevice,
    pipelines: Pipelines,
    seeds: Uint8Array[],
): Promise<Uint8Array[]> {
    const results: Uint8Array[] = [];
    for (let off = 0; off < seeds.length; off += BATCH_SIZE) {
        const chunk = await deriveBatchFused(device, pipelines, seeds.slice(off, off + BATCH_SIZE));
        results.push(...chunk);
    }
    return results;
}

async function deriveBatchFused(
    device: GPUDevice,
    pipelines: Pipelines,
    seeds: Uint8Array[],
): Promise<Uint8Array[]> {
    const N = seeds.length;

    const seedsFlat = new Uint8Array(N * 32);
    for (let i = 0; i < N; i++) seedsFlat.set(seeds[i].subarray(0, 32), i * 32);

    const seedBuf   = createStorageBuffer(device, N * 32, seedsFlat);
    const pubkeyBuf = device.createBuffer({
        size: N * 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const bg = device.createBindGroup({
        layout: pipelines.derive.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: seedBuf } },
            { binding: 1, resource: { buffer: pubkeyBuf } },
        ],
    });
    const enc  = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipelines.derive);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(N / 64));
    pass.end();
    device.queue.submit([enc.finish()]);
    seedBuf.destroy();

    const pubkeyData = await readbackBuffer(device, pubkeyBuf, N * 32);
    pubkeyBuf.destroy();

    return Array.from({ length: N }, (_, i) => pubkeyData.slice(i * 32, i * 32 + 32));
}
