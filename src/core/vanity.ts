import { createStorageBuffer, readbackBuffer } from './buffers.js';
import type { Pipelines } from './pipelines.js';

export type VanityBatchOpts = {
    L: Uint32Array;       // 8 u32s LE — base58 lower bound
    H: Uint32Array;       // 8 u32s LE — base58 upper bound
    hasPrefix: boolean;
    suffixMod: number;
    suffixVal: number;
    hasSuffix: boolean;
};

// Run one GPU vanity batch. Returns seeds (as raw 32-byte Uint8Arrays) of keys
// that passed the GPU prefix/suffix filter. CPU must re-verify all returned seeds.
export async function runVanityBatch(
    device: GPUDevice,
    pipelines: Pipelines,
    gTableBuf: GPUBuffer,
    seeds: Uint8Array[],
    opts: VanityBatchOpts,
): Promise<Uint8Array[]> {
    const N = seeds.length;

    const seedsFlat = new Uint8Array(N * 32);
    for (let i = 0; i < N; i++) seedsFlat.set(seeds[i].subarray(0, 32), i * 32);

    const seedBuf     = createStorageBuffer(device, N * 32, seedsFlat);
    const hitCountBuf = device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const hitSeedsBuf = device.createBuffer({
        size: N * 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Uniforms: L[8] + H[8] + ctrl[4] = 20 u32s = 80 bytes
    const uniformData = new Uint32Array(20);
    uniformData.set(opts.L, 0);
    uniformData.set(opts.H, 8);
    uniformData[16] = opts.suffixMod;
    uniformData[17] = opts.suffixVal;
    uniformData[18] = opts.hasPrefix ? 1 : 0;
    uniformData[19] = opts.hasSuffix ? 1 : 0;

    const uniformBuf = device.createBuffer({
        size: 80,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuf, 0, uniformData);

    // Zero hit_count before dispatch by writing into a staging buffer first.
    // Since hit_count has no COPY_DST, we clear via a zero-init storage buffer trick:
    // Instead, we allocate hit_count fresh each batch (cheaper than staging copy).

    const bg = device.createBindGroup({
        layout: pipelines.vanity.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: seedBuf } },
            { binding: 1, resource: { buffer: gTableBuf } },
            { binding: 2, resource: { buffer: hitCountBuf } },
            { binding: 3, resource: { buffer: hitSeedsBuf } },
            { binding: 4, resource: { buffer: uniformBuf } },
        ],
    });

    const enc  = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipelines.vanity);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(N / 64));
    pass.end();
    device.queue.submit([enc.finish()]);

    seedBuf.destroy();
    uniformBuf.destroy();

    const countData = await readbackBuffer(device, hitCountBuf, 4);
    hitCountBuf.destroy();

    const hitCount = new Uint32Array(countData.buffer, countData.byteOffset, 1)[0];
    if (hitCount === 0) {
        hitSeedsBuf.destroy();
        return [];
    }

    const actual    = Math.min(hitCount, N);
    const seedData  = await readbackBuffer(device, hitSeedsBuf, actual * 32);
    hitSeedsBuf.destroy();

    return Array.from({ length: actual }, (_, i) => seedData.slice(i * 32, i * 32 + 32));
}
