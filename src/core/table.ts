import { ed25519 } from '@noble/curves/ed25519';
import { createStorageBuffer } from './buffers.js';

const P25519 = (1n << 255n) - 19n;

// Build the precomputed table of 255 affine points 2^i·G.
// Layout: 255 × 96 bytes = point i at bytes [i*96 .. i*96+95]:
//   bytes [0..31]  = x-coordinate (little-endian)
//   bytes [32..63] = y-coordinate (little-endian)
//   bytes [64..95] = t = x·y mod p (little-endian) — avoids one field_mul per non-zero bit
export function computeGTable(): Uint8Array {
    const table = new Uint8Array(255 * 96);
    let p = ed25519.ExtendedPoint.BASE;
    for (let i = 0; i < 255; i++) {
        const aff = p.toAffine();
        const t   = (aff.x * aff.y) % P25519;
        table.set(leBytes(aff.x, 32), i * 96);
        table.set(leBytes(aff.y, 32), i * 96 + 32);
        table.set(leBytes(t,     32), i * 96 + 64);
        p = p.double();
    }
    return table;
}

export function createGTableBuffer(device: GPUDevice, tableData: Uint8Array): GPUBuffer {
    return createStorageBuffer(device, tableData.byteLength, tableData);
}

function leBytes(n: bigint, size: number): Uint8Array {
    const buf = new Uint8Array(size);
    let v = n;
    for (let i = 0; i < size; i++) {
        buf[i] = Number(v & 0xFFn);
        v >>= 8n;
    }
    return buf;
}
