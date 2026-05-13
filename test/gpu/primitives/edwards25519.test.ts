import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bigintWgsl from '../../../src/shaders/primitives/bigint.wgsl?raw';
import ffWgsl     from '../../../src/shaders/primitives/ff.wgsl?raw';
import edWgsl     from '../../../src/shaders/primitives/edwards25519.wgsl?raw';

const BASE_WGSL = bigintWgsl + '\n' + ffWgsl + '\n' + edWgsl;

const P = 2n ** 255n - 19n;

// Expected constants (verified by Python against RFC 8032)
const CURVE_D    = 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3n;
const CURVE_2D   = 0x2406d9dc56dffce7198e80f2eef3d13000e0149a8283b156ebd69b9426b2f159n;
const BASE_Y     = 0x6666666666666666666666666666666666666666666666666666666666666658n;
const BASE_X     = 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an;

function bigintToBytesLE(n: bigint, len = 32): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) { out[i] = Number(n & 0xFFn); n >>= 8n; }
    return out;
}

function bytesLEtoBigint(b: Uint8Array): bigint {
    let n = 0n;
    for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
    return n;
}

// Shader that calls a no-argument constant function and writes its 32-byte encoding.
function constEntry(fn: string): string {
    return `
@group(0) @binding(0) var<storage, read_write> out: array<u32>;

@compute @workgroup_size(1)
fn main() {
    let r  = ${fn}();
    let rb = bigint_to_bytes_le(r);
    out[0u] = rb[0u]; out[1u] = rb[1u]; out[2u] = rb[2u]; out[3u] = rb[3u];
    out[4u] = rb[4u]; out[5u] = rb[5u]; out[6u] = rb[6u]; out[7u] = rb[7u];
}`;
}

let gpuDevice: GPUDevice | null = null;

async function getDevice(): Promise<GPUDevice> {
    if (gpuDevice) return gpuDevice;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    gpuDevice = await adapter.requestDevice();
    return gpuDevice;
}

async function readConstant(fn: string): Promise<bigint> {
    const device = await getDevice();
    const bytes = 32;
    const bufOut  = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const bufRead = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    const module   = device.createShaderModule({ code: BASE_WGSL + '\n' + constEntry(fn) });
    const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
    });
    const bg = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: bufOut } }],
    });

    const enc  = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(bufOut, 0, bufRead, 0, bytes);
    device.queue.submit([enc.finish()]);

    await bufRead.mapAsync(GPUMapMode.READ);
    const raw = new Uint8Array(bufRead.getMappedRange().slice(0));
    bufRead.unmap();
    bufOut.destroy(); bufRead.destroy();
    return bytesLEtoBigint(raw);
}

afterAll(() => { gpuDevice?.destroy(); gpuDevice = null; });

describe('edwards25519 — curve constants', () => {
    it('curve_d matches RFC 8032', async () => {
        const got = await readConstant('curve_d');
        expect(got).toBe(CURVE_D);
    }, 15_000);

    it('curve_2d == 2·d mod p', async () => {
        const got = await readConstant('curve_2d');
        expect(got).toBe(CURVE_2D);
        expect(got).toBe((2n * CURVE_D) % P);
    }, 15_000);

    it('curve_base_y == 4/5 mod p', async () => {
        const got = await readConstant('curve_base_y');
        expect(got).toBe(BASE_Y);
        // verify: 5*y ≡ 4 mod p
        expect((5n * got) % P).toBe(4n);
    }, 15_000);

    it('curve_base_x is even and satisfies the curve equation', async () => {
        const x = await readConstant('curve_base_x');
        expect(x).toBe(BASE_X);
        expect(x % 2n).toBe(0n);
        // -x² + y² ≡ 1 + d·x²·y² mod p
        const x2  = (x * x) % P;
        const y2  = (BASE_Y * BASE_Y) % P;
        const lhs = ((-x2 + y2) % P + P) % P;
        const rhs = (1n + CURVE_D * x2 % P * y2) % P;
        expect(lhs).toBe(rhs);
    }, 15_000);
});
