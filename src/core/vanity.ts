import type { Pipelines } from './pipelines.js';

export type VanityBatchOpts = {
    L: Uint32Array;       // 8 u32s LE — base58 lower bound
    H: Uint32Array;       // 8 u32s LE — base58 upper bound
    hasPrefix: boolean;
    suffixMod: number;
    suffixVal: number;
    hasSuffix: boolean;
};

// Pre-allocated GPU buffers for vanity batches of a fixed size N.
// countStagingBuf is co-submitted in the same encoder as the compute pass
// so there is only ONE GPU submission per batch (no second round-trip for hitCount).
// hitSeedsStagingBuf is pre-allocated to avoid buffer creation on the hit path.
export type VanityBufs = {
    N: number;
    seedBuf: GPUBuffer;              // N×32 B — STORAGE | COPY_DST
    hitCountBuf: GPUBuffer;          // 4 B    — STORAGE | COPY_SRC | COPY_DST
    hitSeedsBuf: GPUBuffer;          // N×32 B — STORAGE | COPY_SRC
    uniformBuf: GPUBuffer;           // 80 B   — UNIFORM | COPY_DST
    countStagingBuf: GPUBuffer;      // 4 B    — MAP_READ | COPY_DST
    hitSeedsStagingBuf: GPUBuffer;   // N×32 B — MAP_READ | COPY_DST (pre-allocated)
    bindGroup: GPUBindGroup;
};

const ZERO_U32 = new Uint32Array([0]);

export function createVanityBufs(
    device: GPUDevice,
    pipelines: Pipelines,
    gTableBuf: GPUBuffer,
    N: number,
): VanityBufs {
    const seedBuf = device.createBuffer({
        size: N * 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const hitCountBuf = device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const hitSeedsBuf = device.createBuffer({
        size: N * 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const uniformBuf = device.createBuffer({
        size: 80,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const countStagingBuf = device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const hitSeedsStagingBuf = device.createBuffer({
        size: N * 32,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = device.createBindGroup({
        layout: pipelines.vanity.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: seedBuf } },
            { binding: 1, resource: { buffer: gTableBuf } },
            { binding: 2, resource: { buffer: hitCountBuf } },
            { binding: 3, resource: { buffer: hitSeedsBuf } },
            { binding: 4, resource: { buffer: uniformBuf } },
        ],
    });
    return { N, seedBuf, hitCountBuf, hitSeedsBuf, uniformBuf, countStagingBuf, hitSeedsStagingBuf, bindGroup };
}

export function destroyVanityBufs(bufs: VanityBufs): void {
    bufs.seedBuf.destroy();
    bufs.hitCountBuf.destroy();
    bufs.hitSeedsBuf.destroy();
    bufs.uniformBuf.destroy();
    bufs.countStagingBuf.destroy();
    bufs.hitSeedsStagingBuf.destroy();
}

// Run one GPU vanity batch using pre-allocated buffers.
// Compute pass + hitCount copy are submitted in a SINGLE encoder → one GPU round-trip.
export async function runVanityBatch(
    device: GPUDevice,
    pipelines: Pipelines,
    bufs: VanityBufs,
    seedsFlat: Uint8Array,
    opts: VanityBatchOpts,
): Promise<Uint8Array[]> {
    const N = bufs.N;

    device.queue.writeBuffer(bufs.seedBuf, 0, seedsFlat.buffer as ArrayBuffer, seedsFlat.byteOffset, seedsFlat.byteLength);
    device.queue.writeBuffer(bufs.hitCountBuf, 0, ZERO_U32);

    const uniformData = new Uint32Array(20);
    uniformData.set(opts.L, 0);
    uniformData.set(opts.H, 8);
    uniformData[16] = opts.suffixMod;
    uniformData[17] = opts.suffixVal;
    uniformData[18] = opts.hasPrefix ? 1 : 0;
    uniformData[19] = opts.hasSuffix ? 1 : 0;
    device.queue.writeBuffer(bufs.uniformBuf, 0, uniformData);

    // Single submission: compute + copy hitCount to pre-allocated staging buffer.
    const enc  = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipelines.vanity);
    pass.setBindGroup(0, bufs.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(N / 64));
    pass.end();
    enc.copyBufferToBuffer(bufs.hitCountBuf, 0, bufs.countStagingBuf, 0, 4);
    device.queue.submit([enc.finish()]);

    await bufs.countStagingBuf.mapAsync(GPUMapMode.READ);
    const hitCount = new Uint32Array(bufs.countStagingBuf.getMappedRange())[0];
    bufs.countStagingBuf.unmap();

    if (hitCount === 0) return [];

    const actual = Math.min(hitCount, N);
    const enc2 = device.createCommandEncoder();
    enc2.copyBufferToBuffer(bufs.hitSeedsBuf, 0, bufs.hitSeedsStagingBuf, 0, actual * 32);
    device.queue.submit([enc2.finish()]);
    await bufs.hitSeedsStagingBuf.mapAsync(GPUMapMode.READ);
    const seedData = new Uint8Array(bufs.hitSeedsStagingBuf.getMappedRange().slice(0));
    bufs.hitSeedsStagingBuf.unmap();

    return Array.from({ length: actual }, (_, i) => seedData.slice(i * 32, i * 32 + 32));
}
