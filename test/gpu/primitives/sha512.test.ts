import { sha512 } from '@noble/hashes/sha512';
import { describe, expect, it } from 'vitest';
import primitiveWgsl from '../../../src/shaders/primitives/sha512.wgsl?raw';
import pipelineWgsl from '../../../src/shaders/pipeline_sha512.wgsl?raw';

const SHADER_SOURCE = primitiveWgsl + '\n' + pipelineWgsl;

async function runSha512(seeds: Uint8Array[]): Promise<Uint8Array[]> {
    const gpu = navigator.gpu;
    if (!gpu) throw new Error('WebGPU not supported');
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error('No adapter');
    const device = await adapter.requestDevice();

    const N = seeds.length;
    const seedsFlat = new Uint8Array(N * 32);
    for (let i = 0; i < N; i++) seedsFlat.set(seeds[i], i * 32);

    const seedBuf = device.createBuffer({
        size: seedsFlat.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const digestBuf = device.createBuffer({
        size: N * 64,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readBuf = device.createBuffer({
        size: N * 64,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    device.queue.writeBuffer(seedBuf, 0, seedsFlat);

    const module   = device.createShaderModule({ code: SHADER_SOURCE });
    const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
    });
    const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: seedBuf } },
            { binding: 1, resource: { buffer: digestBuf } },
        ],
    });

    const enc  = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(N / 64));
    pass.end();
    enc.copyBufferToBuffer(digestBuf, 0, readBuf, 0, N * 64);
    device.queue.submit([enc.finish()]);

    await readBuf.mapAsync(GPUMapMode.READ);
    const raw = new Uint8Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();

    seedBuf.destroy();
    digestBuf.destroy();
    readBuf.destroy();
    device.destroy();

    return Array.from({ length: N }, (_, i) => raw.slice(i * 64, i * 64 + 64));
}

const KNOWN_SEEDS: { label: string; seed: Uint8Array }[] = [
    { label: 'all-zero', seed: new Uint8Array(32) },
    { label: 'all-0xFF', seed: new Uint8Array(32).fill(0xFF) },
    {
        label: 'incrementing',
        seed: Uint8Array.from({ length: 32 }, (_, i) => i),
    },
    {
        // RFC 8032 test vector 1 private key seed
        label: 'rfc8032-vec1',
        seed: Uint8Array.from([
            0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60,
            0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c, 0xc4,
            0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19,
            0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae, 0x3d, 0x55,
        ]),
    },
    {
        // RFC 8032 test vector 2 private key seed
        label: 'rfc8032-vec2',
        seed: Uint8Array.from([
            0x4c, 0xcd, 0x08, 0x9b, 0x28, 0xff, 0x96, 0xda,
            0x9d, 0xb6, 0xc3, 0x46, 0xec, 0x11, 0x4e, 0x0f,
            0x5b, 0x8a, 0x31, 0x9f, 0x35, 0xab, 0xa6, 0x24,
            0xda, 0x8c, 0xf6, 0xed, 0x4d, 0x0b, 0x59, 0x2b,
        ]),
    },
];

describe('SHA-512 WGSL pipeline — known vectors', () => {
    it('matches @noble/hashes for known seeds', async () => {
        const results = await runSha512(KNOWN_SEEDS.map(({ seed }) => seed));
        for (let i = 0; i < KNOWN_SEEDS.length; i++) {
            const expected = sha512(KNOWN_SEEDS[i].seed);
            expect(results[i], KNOWN_SEEDS[i].label).toEqual(expected);
        }
    });
});

describe('SHA-512 WGSL pipeline — 1000 random seeds', () => {
    it('matches @noble/hashes for 1000 random seeds', async () => {
        const seeds = Array.from({ length: 1000 }, () => {
            const s = new Uint8Array(32);
            crypto.getRandomValues(s);
            return s;
        });
        const results = await runSha512(seeds);
        for (let i = 0; i < seeds.length; i++) {
            const expected = sha512(seeds[i]);
            if (!expected.every((b, j) => b === results[i][j])) {
                throw new Error(`Mismatch at seed index ${i}`);
            }
        }
        // All 1000 matched
        expect(results).toHaveLength(1000);
    });
});
