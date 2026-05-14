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
        const chunk = await deriveBatch(device, pipelines, seeds.slice(off, off + BATCH_SIZE));
        results.push(...chunk);
    }
    return results;
}

async function deriveBatch(
    device: GPUDevice,
    pipelines: Pipelines,
    seeds: Uint8Array[],
): Promise<Uint8Array[]> {
    const N = seeds.length;

    const seedsFlat = new Uint8Array(N * 32);
    for (let i = 0; i < N; i++) seedsFlat.set(seeds[i].subarray(0, 32), i * 32);

    // Pass 1: seeds → clamped SHA-512 digests (64 bytes each, first 32 = scalar)
    const seedBuf   = createStorageBuffer(device, N * 32, seedsFlat);
    const digestBuf = device.createBuffer({
        size: N * 64,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    {
        const bg = device.createBindGroup({
            layout: pipelines.sha512.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: seedBuf } },
                { binding: 1, resource: { buffer: digestBuf } },
            ],
        });
        const enc  = device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(pipelines.sha512);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(Math.ceil(N / 64));
        pass.end();
        device.queue.submit([enc.finish()]);
    }
    seedBuf.destroy();

    // CPU round-trip: extract first 32 bytes (clamped scalar) from each 64-byte digest
    const digestData  = await readbackBuffer(device, digestBuf, N * 64);
    digestBuf.destroy();

    const scalarsFlat = new Uint8Array(N * 32);
    for (let i = 0; i < N; i++) scalarsFlat.set(digestData.subarray(i * 64, i * 64 + 32), i * 32);

    // Pass 2: clamped scalars → compressed public keys
    const scalarBuf = createStorageBuffer(device, N * 32, scalarsFlat);
    const pubkeyBuf = device.createBuffer({
        size: N * 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    {
        const bg = device.createBindGroup({
            layout: pipelines.scalarMult.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: scalarBuf } },
                { binding: 1, resource: { buffer: pubkeyBuf } },
            ],
        });
        const enc  = device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(pipelines.scalarMult);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(Math.ceil(N / 64));
        pass.end();
        device.queue.submit([enc.finish()]);
    }
    scalarBuf.destroy();

    const pubkeyData = await readbackBuffer(device, pubkeyBuf, N * 32);
    pubkeyBuf.destroy();

    return Array.from({ length: N }, (_, i) => pubkeyData.slice(i * 32, i * 32 + 32));
}
