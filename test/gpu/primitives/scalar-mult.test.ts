import { ed25519 } from '@noble/curves/ed25519';
import { afterAll, describe, expect, it } from 'vitest';
import bigintWgsl from '../../../src/shaders/primitives/bigint.wgsl?raw';
import ffWgsl     from '../../../src/shaders/primitives/ff.wgsl?raw';
import edWgsl     from '../../../src/shaders/primitives/edwards25519.wgsl?raw';

const BASE_WGSL = bigintWgsl + '\n' + ffWgsl + '\n' + edWgsl;

const CURVE_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

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

function randomScalar(): bigint {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    bytes[31] = 0; // keep < 2^248, well below curve order
    const n = bytesLEtoBigint(bytes);
    return n === 0n ? 1n : n;
}

// Entry: reads N scalars (8×u32 LE each), writes N compressed points (8×u32 each).
const SCALAR_MULT_ENTRY = `
@group(0) @binding(0) var<storage, read>       in_scalars: array<u32>;
@group(0) @binding(1) var<storage, read_write> out:        array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= arrayLength(&out) / 8u) { return; }
    let b = idx * 8u;
    var sc = array<u32, 8>(
        in_scalars[b+0u], in_scalars[b+1u], in_scalars[b+2u], in_scalars[b+3u],
        in_scalars[b+4u], in_scalars[b+5u], in_scalars[b+6u], in_scalars[b+7u]
    );
    var one_arr = array<u32, 8>(1u, 0u, 0u, 0u, 0u, 0u, 0u, 0u);
    let gx   = curve_base_x();
    let gy   = curve_base_y();
    let gz   = bigint_from_bytes_le(&one_arr);
    let gt   = field_mul(gx, gy);
    let base = PointExtended(gx, gy, gz, gt);
    let r    = scalar_mult(&sc, base);
    let rb   = point_compress(r);
    let ob   = idx * 8u;
    out[ob+0u]=rb[0u]; out[ob+1u]=rb[1u]; out[ob+2u]=rb[2u]; out[ob+3u]=rb[3u];
    out[ob+4u]=rb[4u]; out[ob+5u]=rb[5u]; out[ob+6u]=rb[6u]; out[ob+7u]=rb[7u];
}`;

let gpuDevice: GPUDevice | null = null;

async function getDevice(): Promise<GPUDevice> {
    if (gpuDevice) return gpuDevice;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    gpuDevice = await adapter.requestDevice();
    return gpuDevice;
}

async function runScalarMult(scalars: bigint[]): Promise<Uint8Array[]> {
    const device  = await getDevice();
    const N       = scalars.length;
    const flatIn  = new Uint32Array(N * 8);
    for (let i = 0; i < N; i++) {
        flatIn.set(new Uint32Array(bigintToBytesLE(scalars[i]).buffer), i * 8);
    }
    const inBytes  = N * 32;
    const outBytes = N * 32;
    const bufIn   = device.createBuffer({ size: inBytes,  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const bufOut  = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const bufRead = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(bufIn, 0, flatIn);
    const module   = device.createShaderModule({ code: BASE_WGSL + '\n' + SCALAR_MULT_ENTRY });
    const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
    });
    const bg = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: bufIn  } },
            { binding: 1, resource: { buffer: bufOut } },
        ],
    });
    const enc  = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(N / 64));
    pass.end();
    enc.copyBufferToBuffer(bufOut, 0, bufRead, 0, outBytes);
    device.queue.submit([enc.finish()]);
    await bufRead.mapAsync(GPUMapMode.READ);
    const raw = new Uint8Array(bufRead.getMappedRange().slice(0));
    bufRead.unmap();
    bufIn.destroy(); bufOut.destroy(); bufRead.destroy();
    return Array.from({ length: N }, (_, i) => raw.slice(i * 32, i * 32 + 32));
}

afterAll(() => { gpuDevice?.destroy(); gpuDevice = null; });

const ExtPoint = ed25519.ExtendedPoint;

// Compressed identity: y=1, x=0 → LE bytes [0x01, 0x00, ..., 0x00]
const IDENTITY_COMPRESSED = (() => { const b = new Uint8Array(32); b[0] = 1; return b; })();

describe('scalar_mult — edge scalars', () => {
    it('scalar_mult(0, G) = identity', async () => {
        const [result] = await runScalarMult([0n]);
        expect(result).toEqual(IDENTITY_COMPRESSED);
    }, 30_000);

    it('scalar_mult(1, G) = G', async () => {
        const [result] = await runScalarMult([1n]);
        expect(result).toEqual(ExtPoint.BASE.toRawBytes());
    }, 30_000);

    it('scalar_mult(2, G) = 2G', async () => {
        const [result] = await runScalarMult([2n]);
        expect(result).toEqual(ExtPoint.BASE.double().toRawBytes());
    }, 30_000);

    it('scalar_mult(l-1, G) = -G (matches noble)', async () => {
        const [result] = await runScalarMult([CURVE_ORDER - 1n]);
        expect(result).toEqual(ExtPoint.BASE.multiply(CURVE_ORDER - 1n).toRawBytes());
    }, 30_000);

    it('scalar_mult(l, G) = identity', async () => {
        const [result] = await runScalarMult([CURVE_ORDER]);
        expect(result).toEqual(IDENTITY_COMPRESSED);
    }, 30_000);
});

describe('scalar_mult — 1000 random scalars vs noble', () => {
    it('all match ExtendedPoint.BASE.multiply(scalar).toRawBytes()', async () => {
        const scalars = Array.from({ length: 1000 }, randomScalar);
        const results = await runScalarMult(scalars);
        for (let i = 0; i < scalars.length; i++) {
            const expected = ExtPoint.BASE.multiply(scalars[i]).toRawBytes();
            expect(results[i], `scalar ${i}`).toEqual(expected);
        }
    }, 180_000);
});
