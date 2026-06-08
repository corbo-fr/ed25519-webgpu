import type { Pipelines } from './pipelines.js';

const BATCH_SIZE = 65536;

export type DeriveBufs = {
    N: number;
    seedBuf: GPUBuffer;
    pubkeyBuf: GPUBuffer;
    readBuf: GPUBuffer;
    bindGroup: GPUBindGroup;
};

export function createDeriveBufs(device: GPUDevice, pipelines: Pipelines, gTableBuf: GPUBuffer, N: number): DeriveBufs {
    const seedBuf = device.createBuffer({
        size: N * 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const pubkeyBuf = device.createBuffer({
        size: N * 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readBuf = device.createBuffer({
        size: N * 32,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = device.createBindGroup({
        layout: pipelines.derive.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: seedBuf } },
            { binding: 1, resource: { buffer: pubkeyBuf } },
            { binding: 2, resource: { buffer: gTableBuf } },
        ],
    });
    return { N, seedBuf, pubkeyBuf, readBuf, bindGroup };
}

export function destroyDeriveBufs(bufs: DeriveBufs): void {
    bufs.seedBuf.destroy();
    bufs.pubkeyBuf.destroy();
    bufs.readBuf.destroy();
}

export async function runDeriveBatch(
    device: GPUDevice,
    pipelines: Pipelines,
    bufs: DeriveBufs,
    seeds: Uint8Array[],
): Promise<Uint8Array[]> {
    const N = seeds.length;

    const seedsFlat = new Uint8Array(N * 32);
    for (let i = 0; i < N; i++) seedsFlat.set(seeds[i].subarray(0, 32), i * 32);

    device.queue.writeBuffer(bufs.seedBuf, 0, seedsFlat.buffer as ArrayBuffer, seedsFlat.byteOffset, N * 32);

    const enc  = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipelines.derive);
    pass.setBindGroup(0, bufs.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(N / 64));
    pass.end();
    enc.copyBufferToBuffer(bufs.pubkeyBuf, 0, bufs.readBuf, 0, N * 32);
    device.queue.submit([enc.finish()]);

    await bufs.readBuf.mapAsync(GPUMapMode.READ);
    const data = new Uint8Array(bufs.readBuf.getMappedRange().slice(0));
    bufs.readBuf.unmap();

    return Array.from({ length: N }, (_, i) => data.slice(i * 32, i * 32 + 32));
}

// One-shot derive — creates and destroys buffers per call.
// Used by external callers; Ed25519GPU.derivePublicKeys uses the pre-alloc path.
export async function derivePublicKeys(
    device: GPUDevice,
    pipelines: Pipelines,
    gTableBuf: GPUBuffer,
    seeds: Uint8Array[],
): Promise<Uint8Array[]> {
    const results: Uint8Array[] = [];
    for (let off = 0; off < seeds.length; off += BATCH_SIZE) {
        const chunk = seeds.slice(off, off + BATCH_SIZE);
        const bufs  = createDeriveBufs(device, pipelines, gTableBuf, chunk.length);
        results.push(...await runDeriveBatch(device, pipelines, bufs, chunk));
        destroyDeriveBufs(bufs);
    }
    return results;
}
