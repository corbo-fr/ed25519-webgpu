const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58Val(c: string): number {
    const i = BASE58.indexOf(c);
    if (i < 0) throw new Error(`Invalid base58 character: '${c}'`);
    return i;
}

// Pure numeric base58 decode — no leading-zero-byte special-casing.
// Returns 32-byte big-endian array (index 0 = MSB) or null on overflow.
function decodeNumericBE(s: string): Uint8Array | null {
    const out = new Uint8Array(32);
    for (const c of s) {
        let carry = b58Val(c);
        for (let i = 31; i >= 0; i--) {
            carry += 58 * out[i];
            out[i] = carry & 0xFF;
            carry >>= 8;
        }
        if (carry > 0) return null; // overflow
    }
    return out;
}

function compareBE(a: Uint8Array, b: Uint8Array): number {
    for (let i = 0; i < 32; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

// Convert 32-byte big-endian array to 8 LE u32s for the GPU uniform.
// bigint_from_bytes_le of this result equals the big-endian numeric value.
function beToLeU32(be: Uint8Array): Uint32Array {
    const u32 = new Uint32Array(8);
    for (let i = 0; i < 8; i++) {
        const j = 31 - i * 4; // j = 31, 27, 23, ..., 3
        u32[i] = (be[j] | (be[j - 1] << 8) | (be[j - 2] << 16) | (be[j - 3] << 24)) >>> 0;
    }
    return u32;
}

// Compute L/H bounds (8 LE u32s each) for the GPU prefix filter.
// The GPU checks: bigint_be(pubkey) ∈ [L, H] where bigint_be uses the
// base58 numeric interpretation (pubkey bytes treated as big-endian integer).
// Returns null if prefix is empty or too long.
export function computePrefixBounds(prefix: string): { L: Uint32Array; H: Uint32Array } | null {
    if (!prefix) return null;

    const MAX_H = new Uint8Array(32).fill(0xFF);

    let L_be: Uint8Array | null = null;
    let H_be: Uint8Array | null = null;

    for (const len of [43, 44]) {
        const pad = len - prefix.length;
        if (pad < 0) continue;

        const lStr = prefix + '1'.repeat(pad);
        const hStr = prefix + 'z'.repeat(pad);

        const l = decodeNumericBE(lStr);
        const h = decodeNumericBE(hStr);

        if (l !== null) {
            if (L_be === null || compareBE(l, L_be) < 0) L_be = l;
        }
        // If h overflowed (null), the upper bound is effectively 0xFFF...F.
        const hEff = h ?? MAX_H;
        if (H_be === null || compareBE(hEff, H_be) > 0) H_be = hEff;
    }

    if (L_be === null || H_be === null) return null;
    return { L: beToLeU32(L_be), H: beToLeU32(H_be) };
}

// Compute suffix mod/val for GPU suffix filter (k ≤ 4 only).
// Returns null if suffix is empty or too long for GPU safe arithmetic.
export function computeSuffixParams(suffix: string): { mod: number; val: number } | null {
    if (!suffix || suffix.length > 4) return null;
    let mod = 1;
    let val = 0;
    for (const c of suffix) {
        mod *= 58;
        val = val * 58 + b58Val(c);
    }
    return { mod, val };
}
