import { ed25519 } from '@noble/curves/ed25519';
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

// --- point operation helpers ---

const ExtPoint = ed25519.ExtendedPoint;
type EPoint = InstanceType<typeof ed25519.ExtendedPoint>;

function randomScalar(): bigint {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    bytes[31] = 0; // keep < 2^248, well below curve order
    const n = bytesLEtoBigint(bytes);
    return n === 0n ? 1n : n;
}

// Encode an extended point as 32 u32: [X(8), Y(8), Z(8), T(8)]
function encodePoint(p: EPoint): Uint32Array {
    const words = new Uint32Array(32);
    words.set(new Uint32Array(bigintToBytesLE(p.ex).buffer),  0);
    words.set(new Uint32Array(bigintToBytesLE(p.ey).buffer),  8);
    words.set(new Uint32Array(bigintToBytesLE(p.ez).buffer), 16);
    words.set(new Uint32Array(bigintToBytesLE(p.et).buffer), 24);
    return words;
}

// --- WGSL entries for point operations ---

const POINT_ADD_ENTRY = `
@group(0) @binding(0) var<storage, read>       in_p: array<u32>;
@group(0) @binding(1) var<storage, read>       in_q: array<u32>;
@group(0) @binding(2) var<storage, read_write> out:  array<u32>;

@compute @workgroup_size(64)
fn main2(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= arrayLength(&out) / 8u) { return; }
    let b = idx * 32u;
    var xb1 = array<u32,8>(in_p[b+ 0u],in_p[b+ 1u],in_p[b+ 2u],in_p[b+ 3u],in_p[b+ 4u],in_p[b+ 5u],in_p[b+ 6u],in_p[b+ 7u]);
    var yb1 = array<u32,8>(in_p[b+ 8u],in_p[b+ 9u],in_p[b+10u],in_p[b+11u],in_p[b+12u],in_p[b+13u],in_p[b+14u],in_p[b+15u]);
    var zb1 = array<u32,8>(in_p[b+16u],in_p[b+17u],in_p[b+18u],in_p[b+19u],in_p[b+20u],in_p[b+21u],in_p[b+22u],in_p[b+23u]);
    var tb1 = array<u32,8>(in_p[b+24u],in_p[b+25u],in_p[b+26u],in_p[b+27u],in_p[b+28u],in_p[b+29u],in_p[b+30u],in_p[b+31u]);
    var xb2 = array<u32,8>(in_q[b+ 0u],in_q[b+ 1u],in_q[b+ 2u],in_q[b+ 3u],in_q[b+ 4u],in_q[b+ 5u],in_q[b+ 6u],in_q[b+ 7u]);
    var yb2 = array<u32,8>(in_q[b+ 8u],in_q[b+ 9u],in_q[b+10u],in_q[b+11u],in_q[b+12u],in_q[b+13u],in_q[b+14u],in_q[b+15u]);
    var zb2 = array<u32,8>(in_q[b+16u],in_q[b+17u],in_q[b+18u],in_q[b+19u],in_q[b+20u],in_q[b+21u],in_q[b+22u],in_q[b+23u]);
    var tb2 = array<u32,8>(in_q[b+24u],in_q[b+25u],in_q[b+26u],in_q[b+27u],in_q[b+28u],in_q[b+29u],in_q[b+30u],in_q[b+31u]);
    let p  = PointExtended(bigint_from_bytes_le(&xb1),bigint_from_bytes_le(&yb1),bigint_from_bytes_le(&zb1),bigint_from_bytes_le(&tb1));
    let q  = PointExtended(bigint_from_bytes_le(&xb2),bigint_from_bytes_le(&yb2),bigint_from_bytes_le(&zb2),bigint_from_bytes_le(&tb2));
    let r  = point_add(p, q);
    let rb = point_compress(r);
    let ob = idx * 8u;
    out[ob+0u]=rb[0u]; out[ob+1u]=rb[1u]; out[ob+2u]=rb[2u]; out[ob+3u]=rb[3u];
    out[ob+4u]=rb[4u]; out[ob+5u]=rb[5u]; out[ob+6u]=rb[6u]; out[ob+7u]=rb[7u];
}`;

function pointUnaryEntry(op: 'point_double' | 'compress_only'): string {
    const body = op === 'compress_only' ? `let r = p;` : `let r = point_double(p);`;
    return `
@group(0) @binding(0) var<storage, read>       in_p: array<u32>;
@group(0) @binding(1) var<storage, read_write> out:  array<u32>;

@compute @workgroup_size(64)
fn main2(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= arrayLength(&out) / 8u) { return; }
    let b = idx * 32u;
    var xb = array<u32,8>(in_p[b+ 0u],in_p[b+ 1u],in_p[b+ 2u],in_p[b+ 3u],in_p[b+ 4u],in_p[b+ 5u],in_p[b+ 6u],in_p[b+ 7u]);
    var yb = array<u32,8>(in_p[b+ 8u],in_p[b+ 9u],in_p[b+10u],in_p[b+11u],in_p[b+12u],in_p[b+13u],in_p[b+14u],in_p[b+15u]);
    var zb = array<u32,8>(in_p[b+16u],in_p[b+17u],in_p[b+18u],in_p[b+19u],in_p[b+20u],in_p[b+21u],in_p[b+22u],in_p[b+23u]);
    var tb = array<u32,8>(in_p[b+24u],in_p[b+25u],in_p[b+26u],in_p[b+27u],in_p[b+28u],in_p[b+29u],in_p[b+30u],in_p[b+31u]);
    let p  = PointExtended(bigint_from_bytes_le(&xb),bigint_from_bytes_le(&yb),bigint_from_bytes_le(&zb),bigint_from_bytes_le(&tb));
    ${body}
    let rb = point_compress(r);
    let ob = idx * 8u;
    out[ob+0u]=rb[0u]; out[ob+1u]=rb[1u]; out[ob+2u]=rb[2u]; out[ob+3u]=rb[3u];
    out[ob+4u]=rb[4u]; out[ob+5u]=rb[5u]; out[ob+6u]=rb[6u]; out[ob+7u]=rb[7u];
}`;
}

// --- GPU runners for point operations ---

async function runPointAdd(pairs: [EPoint, EPoint][]): Promise<Uint8Array[]> {
    const device = await getDevice();
    const N = pairs.length;
    const flatP = new Uint32Array(N * 32);
    const flatQ = new Uint32Array(N * 32);
    for (let i = 0; i < N; i++) {
        flatP.set(encodePoint(pairs[i][0]), i * 32);
        flatQ.set(encodePoint(pairs[i][1]), i * 32);
    }
    const inBytes  = N * 128;
    const outBytes = N * 32;
    const bufP    = device.createBuffer({ size: inBytes,  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const bufQ    = device.createBuffer({ size: inBytes,  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const bufOut  = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const bufRead = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(bufP, 0, flatP);
    device.queue.writeBuffer(bufQ, 0, flatQ);
    const module   = device.createShaderModule({ code: BASE_WGSL + '\n' + POINT_ADD_ENTRY });
    const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'main2' },
    });
    const bg = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: bufP } },
            { binding: 1, resource: { buffer: bufQ } },
            { binding: 2, resource: { buffer: bufOut } },
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
    bufP.destroy(); bufQ.destroy(); bufOut.destroy(); bufRead.destroy();
    return Array.from({ length: N }, (_, i) => raw.slice(i * 32, i * 32 + 32));
}

async function runPointUnary(op: 'point_double' | 'compress_only', points: EPoint[]): Promise<Uint8Array[]> {
    const device = await getDevice();
    const N = points.length;
    const flatP = new Uint32Array(N * 32);
    for (let i = 0; i < N; i++) flatP.set(encodePoint(points[i]), i * 32);
    const inBytes  = N * 128;
    const outBytes = N * 32;
    const bufP    = device.createBuffer({ size: inBytes,  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const bufOut  = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const bufRead = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(bufP, 0, flatP);
    const module   = device.createShaderModule({ code: BASE_WGSL + '\n' + pointUnaryEntry(op) });
    const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'main2' },
    });
    const bg = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: bufP } },
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
    bufP.destroy(); bufOut.destroy(); bufRead.destroy();
    return Array.from({ length: N }, (_, i) => raw.slice(i * 32, i * 32 + 32));
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

describe('edwards25519 — point_add', () => {
    it('point_add(identity, P) = P', async () => {
        const P = ExtPoint.BASE.multiply(3n);
        const [result] = await runPointAdd([[ExtPoint.ZERO, P]]);
        expect(result).toEqual(P.toRawBytes());
    }, 30_000);

    it('point_add(P, identity) = P', async () => {
        const P = ExtPoint.BASE.multiply(7n);
        const [result] = await runPointAdd([[P, ExtPoint.ZERO]]);
        expect(result).toEqual(P.toRawBytes());
    }, 30_000);

    it('point_add(G, G) = 2G', async () => {
        const G = ExtPoint.BASE;
        const [result] = await runPointAdd([[G, G]]);
        expect(result).toEqual(G.double().toRawBytes());
    }, 30_000);

    it('1000 random pairs match noble', async () => {
        const pairs = Array.from({ length: 1000 }, (): [EPoint, EPoint] => [
            ExtPoint.BASE.multiply(randomScalar()),
            ExtPoint.BASE.multiply(randomScalar()),
        ]);
        const results = await runPointAdd(pairs);
        for (let i = 0; i < pairs.length; i++) {
            const expected = pairs[i][0].add(pairs[i][1]).toRawBytes();
            expect(results[i], `pair ${i}`).toEqual(expected);
        }
    }, 120_000);
});

describe('edwards25519 — point_double', () => {
    it('point_double(G) matches noble', async () => {
        const [result] = await runPointUnary('point_double', [ExtPoint.BASE]);
        expect(result).toEqual(ExtPoint.BASE.double().toRawBytes());
    }, 30_000);

    it('1000 random points match noble', async () => {
        const points = Array.from({ length: 1000 }, () => ExtPoint.BASE.multiply(randomScalar()));
        const results = await runPointUnary('point_double', points);
        for (let i = 0; i < points.length; i++) {
            const expected = points[i].double().toRawBytes();
            expect(results[i], `point ${i}`).toEqual(expected);
        }
    }, 120_000);
});

describe('edwards25519 — point_compress', () => {
    it('100 random points match noble', async () => {
        const points = Array.from({ length: 100 }, () => ExtPoint.BASE.multiply(randomScalar()));
        const results = await runPointUnary('compress_only', points);
        for (let i = 0; i < points.length; i++) {
            const expected = points[i].toRawBytes();
            expect(results[i], `point ${i}`).toEqual(expected);
        }
    }, 60_000);
});
