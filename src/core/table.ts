import { ed25519 } from '@noble/curves/ed25519';
import { createStorageBuffer } from './buffers.js';

// Build the precomputed table of 255 points 2^i·G.
// Layout: 255 × 64 bytes = point i at bytes [i*64 .. i*64+63]:
//   bytes [0..31]  = x-coordinate (little-endian)
//   bytes [32..63] = y-coordinate (little-endian)
export function computeGTable(): Uint8Array {
    const table = new Uint8Array(255 * 64);
    let p = ed25519.ExtendedPoint.BASE;
    for (let i = 0; i < 255; i++) {
        const aff = p.toAffine();
        table.set(leBytes(aff.x, 32), i * 64);
        table.set(leBytes(aff.y, 32), i * 64 + 32);
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
