import { ed25519 } from '@noble/curves/ed25519';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bigintWgsl from '../../../src/shaders/primitives/bigint.wgsl?raw';
import ffWgsl     from '../../../src/shaders/primitives/ff.wgsl?raw';

const BASE_WGSL = bigintWgsl + '\n' + ffWgsl;
const Fp = ed25519.CURVE.Fp;
const P  = 2n ** 255n - 19n;

// --- conversion helpers ---

function bytesLEtoBigint(b: Uint8Array): bigint {
    let n = 0n;
    for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
    return n;
}

function bigintToBytesLE(n: bigint, len = 32): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) { out[i] = Number(n & 0xFFn); n >>= 8n; }
    return out;
}

function randomFp(): bigint {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    bytes[31] &= 0x7F; // keep < 2^255
    const n = bytesLEtoBigint(bytes);
    return n >= P ? n - P : n;
}

// --- WGSL entry-point templates ---

function binaryEntry(op: string): string {
    return `
@group(0) @binding(0) var<storage, read>       in_a: array<u32>;
@group(0) @binding(1) var<storage, read>       in_b: array<u32>;
@group(0) @binding(2) var<storage, read_write> out:  array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= arrayLength(&out) / 8u) { return; }
    var ab = array<u32, 8>(
        in_a[idx*8u+0u], in_a[idx*8u+1u], in_a[idx*8u+2u], in_a[idx*8u+3u],
        in_a[idx*8u+4u], in_a[idx*8u+5u], in_a[idx*8u+6u], in_a[idx*8u+7u],
    );
    var bb = array<u32, 8>(
        in_b[idx*8u+0u], in_b[idx*8u+1u], in_b[idx*8u+2u], in_b[idx*8u+3u],
        in_b[idx*8u+4u], in_b[idx*8u+5u], in_b[idx*8u+6u], in_b[idx*8u+7u],
    );
    let a = bigint_from_bytes_le(&ab);
    let b = bigint_from_bytes_le(&bb);
    let r = ${op}(a, b);
    let rb = bigint_to_bytes_le(r);
    out[idx*8u+0u] = rb[0u]; out[idx*8u+1u] = rb[1u];
    out[idx*8u+2u] = rb[2u]; out[idx*8u+3u] = rb[3u];
    out[idx*8u+4u] = rb[4u]; out[idx*8u+5u] = rb[5u];
    out[idx*8u+6u] = rb[6u]; out[idx*8u+7u] = rb[7u];
}`;
}

function unaryEntry(op: string): string {
    return `
@group(0) @binding(0) var<storage, read>       in_a: array<u32>;
@group(0) @binding(1) var<storage, read_write> out:  array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= arrayLength(&out) / 8u) { return; }
    var ab = array<u32, 8>(
        in_a[idx*8u+0u], in_a[idx*8u+1u], in_a[idx*8u+2u], in_a[idx*8u+3u],
        in_a[idx*8u+4u], in_a[idx*8u+5u], in_a[idx*8u+6u], in_a[idx*8u+7u],
    );
    let a = bigint_from_bytes_le(&ab);
    let r = ${op}(a);
    let rb = bigint_to_bytes_le(r);
    out[idx*8u+0u] = rb[0u]; out[idx*8u+1u] = rb[1u];
    out[idx*8u+2u] = rb[2u]; out[idx*8u+3u] = rb[3u];
    out[idx*8u+4u] = rb[4u]; out[idx*8u+5u] = rb[5u];
    out[idx*8u+6u] = rb[6u]; out[idx*8u+7u] = rb[7u];
}`;
}

// --- GPU runner ---

let gpuDevice: GPUDevice | null = null;

async function getDevice(): Promise<GPUDevice> {
    if (gpuDevice) return gpuDevice;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    gpuDevice = await adapter.requestDevice();
    return gpuDevice;
}

async function runBinary(
    op: string,
    pairs: [Uint8Array, Uint8Array][],
): Promise<Uint8Array[]> {
    const device = await getDevice();
    const N = pairs.length;
    const flatA = new Uint32Array(N * 8);
    const flatB = new Uint32Array(N * 8);
    for (let i = 0; i < N; i++) {
        const a32 = new Uint32Array(pairs[i][0].buffer, pairs[i][0].byteOffset, 8);
        const b32 = new Uint32Array(pairs[i][1].buffer, pairs[i][1].byteOffset, 8);
        flatA.set(a32, i * 8);
        flatB.set(b32, i * 8);
    }

    const bytes = N * 32;
    const bufA = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const bufB = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const bufOut = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const bufRead = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    device.queue.writeBuffer(bufA, 0, flatA);
    device.queue.writeBuffer(bufB, 0, flatB);

    const module = device.createShaderModule({ code: BASE_WGSL + '\n' + binaryEntry(op) });
    const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
    });
    const bg = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: bufA } },
            { binding: 1, resource: { buffer: bufB } },
            { binding: 2, resource: { buffer: bufOut } },
        ],
    });

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(N / 64));
    pass.end();
    enc.copyBufferToBuffer(bufOut, 0, bufRead, 0, bytes);
    device.queue.submit([enc.finish()]);

    await bufRead.mapAsync(GPUMapMode.READ);
    const raw = new Uint8Array(bufRead.getMappedRange().slice(0));
    bufRead.unmap();
    bufA.destroy(); bufB.destroy(); bufOut.destroy(); bufRead.destroy();

    return Array.from({ length: N }, (_, i) => raw.slice(i * 32, i * 32 + 32));
}

async function runUnary(
    op: string,
    inputs: Uint8Array[],
): Promise<Uint8Array[]> {
    const device = await getDevice();
    const N = inputs.length;
    const flatA = new Uint32Array(N * 8);
    for (let i = 0; i < N; i++) {
        flatA.set(new Uint32Array(inputs[i].buffer, inputs[i].byteOffset, 8), i * 8);
    }

    const bytes = N * 32;
    const bufA   = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const bufOut  = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const bufRead = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    device.queue.writeBuffer(bufA, 0, flatA);

    const module = device.createShaderModule({ code: BASE_WGSL + '\n' + unaryEntry(op) });
    const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
    });
    const bg = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: bufA } },
            { binding: 1, resource: { buffer: bufOut } },
        ],
    });

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(N / 64));
    pass.end();
    enc.copyBufferToBuffer(bufOut, 0, bufRead, 0, bytes);
    device.queue.submit([enc.finish()]);

    await bufRead.mapAsync(GPUMapMode.READ);
    const raw = new Uint8Array(bufRead.getMappedRange().slice(0));
    bufRead.unmap();
    bufA.destroy(); bufOut.destroy(); bufRead.destroy();

    return Array.from({ length: N }, (_, i) => raw.slice(i * 32, i * 32 + 32));
}

afterAll(() => { gpuDevice?.destroy(); gpuDevice = null; });

// --- Tests ---

describe('field25519 — field_add', () => {
    it('1000 random pairs match Fp.add', async () => {
        const pairs = Array.from({ length: 1000 }, () => [randomFp(), randomFp()] as [bigint, bigint]);
        const gpuIn = pairs.map(([a, b]) => [bigintToBytesLE(a), bigintToBytesLE(b)] as [Uint8Array, Uint8Array]);
        const results = await runBinary('field_add', gpuIn);
        for (let i = 0; i < pairs.length; i++) {
            const expected = bigintToBytesLE(Fp.add(pairs[i][0], pairs[i][1]));
            expect(results[i], `pair ${i}`).toEqual(expected);
        }
    }, 30_000);

    it('edge cases: 0+0, 0+(p-1), (p-1)+(p-1), 1+0', async () => {
        const cases: [bigint, bigint][] = [
            [0n, 0n],
            [0n, P - 1n],
            [P - 1n, P - 1n],
            [1n, 0n],
        ];
        const results = await runBinary('field_add', cases.map(([a, b]) => [bigintToBytesLE(a), bigintToBytesLE(b)]));
        for (let i = 0; i < cases.length; i++) {
            const expected = bigintToBytesLE(Fp.add(cases[i][0], cases[i][1]));
            expect(results[i], `case ${i}`).toEqual(expected);
        }
    }, 15_000);
});

describe('field25519 — field_sub', () => {
    it('1000 random pairs, result always in [0, p)', async () => {
        const pairs = Array.from({ length: 1000 }, () => [randomFp(), randomFp()] as [bigint, bigint]);
        const gpuIn = pairs.map(([a, b]) => [bigintToBytesLE(a), bigintToBytesLE(b)] as [Uint8Array, Uint8Array]);
        const results = await runBinary('field_sub', gpuIn);
        for (let i = 0; i < pairs.length; i++) {
            const expected = bigintToBytesLE(Fp.sub(pairs[i][0], pairs[i][1]));
            expect(results[i], `pair ${i}`).toEqual(expected);
        }
    }, 30_000);

    it('edge cases: 0-0, 0-(p-1), (p-1)-0, (p-1)-(p-1)', async () => {
        const cases: [bigint, bigint][] = [
            [0n, 0n],
            [0n, P - 1n],
            [P - 1n, 0n],
            [P - 1n, P - 1n],
        ];
        const results = await runBinary('field_sub', cases.map(([a, b]) => [bigintToBytesLE(a), bigintToBytesLE(b)]));
        for (let i = 0; i < cases.length; i++) {
            const expected = bigintToBytesLE(Fp.sub(cases[i][0], cases[i][1]));
            expect(results[i], `case ${i}`).toEqual(expected);
        }
    }, 15_000);
});

describe('field25519 — field_mul', () => {
    it('1000 random pairs match Fp.mul', async () => {
        const pairs = Array.from({ length: 1000 }, () => [randomFp(), randomFp()] as [bigint, bigint]);
        const gpuIn = pairs.map(([a, b]) => [bigintToBytesLE(a), bigintToBytesLE(b)] as [Uint8Array, Uint8Array]);
        const results = await runBinary('field_mul', gpuIn);
        for (let i = 0; i < pairs.length; i++) {
            const expected = bigintToBytesLE(Fp.mul(pairs[i][0], pairs[i][1]));
            expect(results[i], `pair ${i}`).toEqual(expected);
        }
    }, 30_000);

    it('edge cases: 0*x, 1*x, (p-1)*(p-1), x*x', async () => {
        const x = randomFp();
        const cases: [bigint, bigint][] = [
            [0n, x],
            [1n, x],
            [P - 1n, P - 1n],
            [x, x],
        ];
        const results = await runBinary('field_mul', cases.map(([a, b]) => [bigintToBytesLE(a), bigintToBytesLE(b)]));
        for (let i = 0; i < cases.length; i++) {
            const expected = bigintToBytesLE(Fp.mul(cases[i][0], cases[i][1]));
            expect(results[i], `case ${i}`).toEqual(expected);
        }
    }, 15_000);
});

describe('field25519 — field_sq', () => {
    it('1000 random values match Fp.sqr', async () => {
        const vals = Array.from({ length: 1000 }, randomFp);
        const results = await runUnary('field_sq', vals.map(v => bigintToBytesLE(v)));
        for (let i = 0; i < vals.length; i++) {
            const expected = bigintToBytesLE(Fp.sqr(vals[i]));
            expect(results[i], `val ${i}`).toEqual(expected);
        }
    }, 30_000);
});

describe('field25519 — field_inv', () => {
    it('500 random values: inv(a)*a == 1', async () => {
        const vals = Array.from({ length: 500 }, randomFp);
        const invResults = await runUnary('field_inv', vals.map(v => bigintToBytesLE(v)));
        for (let i = 0; i < vals.length; i++) {
            const inv = bytesLEtoBigint(invResults[i]);
            const product = Fp.mul(vals[i], inv);
            expect(product, `val ${i}: a*inv(a) should be 1`).toBe(1n);
        }
    }, 120_000);

    it('inv(0) == 0 (by convention)', async () => {
        const results = await runUnary('field_inv', [bigintToBytesLE(0n)]);
        expect(bytesLEtoBigint(results[0])).toBe(0n);
    }, 30_000);
});
