// BigInt primitives for WebGPU/WGSL — 20 limbs × 13 bits = 260 bits.
// Representation: little-endian limbs, each limb holds bits [13k .. 13k+12].
// LIMB_BITS=13, LIMB_MASK=0x1FFF, NUM_LIMBS=20.
//
// Why 13-bit limbs:
//   product of two limbs < (2^13)^2 = 2^26 < 2^32 (fits in u32)
//   max accumulation per output limb: 20 × 2^26 ≈ 2^30.3 < 2^32 (no u64 needed)
//   2^260 ≡ 608 mod (2^255-19) — tiny fold factor
//
// 10-limb × 26-bit investigation (Option A from issue #8):
//   Halving NUM_LIMBS to 10 would cut register pressure per thread by ~½
//   (~170 → ~85 u32 registers) and roughly double GPU occupancy.
//   Blocker: limb products (2^26)² = 2^52 overflow u32 — requires emulating
//   64-bit multiply with two u32 ops (hi/lo schoolbook split).
//   Whether the added instructions per product cancel the occupancy gain is
//   hardware-dependent; profile before committing to the rewrite (~2 days).

const LIMB_BITS: u32 = 13u;
const LIMB_MASK: u32 = 0x1FFFu;
const NUM_LIMBS: u32 = 20u;
const WIDE_LIMBS: u32 = 40u; // 2×20, one extra limb for carry out of schoolbook

struct BigInt     { limbs: array<u32, 20> }
struct BigIntWide { limbs: array<u32, 40> }

fn bigint_zero() -> BigInt {
    return BigInt(array<u32, 20>(
        0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
        0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
    ));
}

fn bigint_one() -> BigInt {
    return BigInt(array<u32, 20>(
        1u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
        0u,0u,0u,0u,0u,0u,0u,0u,0u,0u,
    ));
}

// Addition mod 2^260. Carry wraps at bit 260 (top limb clamped to 13 bits).
fn bigint_add(a: BigInt, b: BigInt) -> BigInt {
    var r: BigInt;
    var carry: u32 = 0u;
    for (var i = 0u; i < NUM_LIMBS; i++) {
        let s = a.limbs[i] + b.limbs[i] + carry;
        r.limbs[i] = s & LIMB_MASK;
        carry = s >> LIMB_BITS;
    }
    return r;
}

// Subtraction mod 2^260. Borrows wrap (caller ensures result stays in range for field use).
fn bigint_sub(a: BigInt, b: BigInt) -> BigInt {
    var r: BigInt;
    var borrow: u32 = 0u;
    for (var i = 0u; i < NUM_LIMBS; i++) {
        // Add 2^13 to avoid underflow, subtract borrow
        let s = a.limbs[i] + (LIMB_MASK + 1u) - b.limbs[i] - borrow;
        r.limbs[i] = s & LIMB_MASK;
        borrow = 1u - (s >> LIMB_BITS);
    }
    return r;
}

// a >= b  (lexicographic from MSB, no min/max, no i-- to avoid Naga issues).
fn bigint_gte(a: BigInt, b: BigInt) -> bool {
    for (var i = NUM_LIMBS - 1u; ; i -= 1u) {
        if (a.limbs[i] > b.limbs[i]) { return true; }
        if (a.limbs[i] < b.limbs[i]) { return false; }
        if (i == 0u) { break; }
    }
    return true; // equal
}

fn bigint_eq(a: BigInt, b: BigInt) -> bool {
    for (var i = 0u; i < NUM_LIMBS; i++) {
        if (a.limbs[i] != b.limbs[i]) { return false; }
    }
    return true;
}

// Schoolbook multiplication → 40-limb wide result.
// Products i+j land in limbs 0..38; carry out of limb 38 goes into limb 39 (≤ 7).
// p^2 < 2^510 = 2^3 × 2^507 fits exactly in 40 × 13-bit limbs (40×13=520 ≥ 510).
fn bigint_mul(a: BigInt, b: BigInt) -> BigIntWide {
    var w: BigIntWide;

    for (var i = 0u; i < NUM_LIMBS; i++) {
        for (var j = 0u; j < NUM_LIMBS; j++) {
            w.limbs[i + j] += a.limbs[i] * b.limbs[j];
        }
    }
    var carry: u32 = 0u;
    for (var i = 0u; i < WIDE_LIMBS; i++) {
        let s = w.limbs[i] + carry;
        w.limbs[i] = s & LIMB_MASK;
        carry = s >> LIMB_BITS;
    }
    return w;
}

// Schoolbook squaring → 40-limb wide result, exploiting a² cross-term symmetry.
// Diagonal (i==j): w[2i] += a[i]²  — 20 products.
// Off-diagonal (i<j, counted twice): w[i+j] += 2×a[i]×a[j]  — 190 products.
// Total: N(N+1)/2 = 210 vs N² = 400 for bigint_mul. ~1.9× faster.
// Overflow safe: max per-limb sum ≈ 10×2×(2^13)² = 2^30.3 < 2^32.
fn bigint_sq(a: BigInt) -> BigIntWide {
    var w: BigIntWide;
    for (var i = 0u; i < NUM_LIMBS; i++) {
        w.limbs[2u * i] += a.limbs[i] * a.limbs[i];
        for (var j = i + 1u; j < NUM_LIMBS; j++) {
            w.limbs[i + j] += 2u * a.limbs[i] * a.limbs[j];
        }
    }
    var carry: u32 = 0u;
    for (var i = 0u; i < WIDE_LIMBS; i++) {
        let s = w.limbs[i] + carry;
        w.limbs[i] = s & LIMB_MASK;
        carry = s >> LIMB_BITS;
    }
    return w;
}

// Load 32 bytes (8 u32, little-endian) into 20 × 13-bit limbs.
// bytes[0] = least-significant byte.
fn bigint_from_bytes_le(bytes: ptr<function, array<u32, 8>>) -> BigInt {
    // Pack 8 u32 little-endian words into a 256-bit stream, extract 13-bit limbs.
    // Strategy: walk bit by bit, but we do it word-by-word for efficiency.
    var r: BigInt;
    var bit_src: u32 = 0u; // current source bit index (0 = LSB of bytes[0])

    for (var limb = 0u; limb < NUM_LIMBS; limb++) {
        let word_idx = bit_src / 32u;
        let bit_off  = bit_src % 32u;

        var val: u32;
        if (bit_off + LIMB_BITS <= 32u) {
            // all 13 bits fit in one word
            val = ((*bytes)[word_idx] >> bit_off) & LIMB_MASK;
        } else {
            // straddles two words
            let lo_bits = 32u - bit_off;
            let hi_bits = LIMB_BITS - lo_bits;
            let lo = (*bytes)[word_idx] >> bit_off;
            let hi = select(0u, (*bytes)[word_idx + 1u], word_idx + 1u < 8u) & ((1u << hi_bits) - 1u);
            val = lo | (hi << lo_bits);
            val &= LIMB_MASK;
        }
        r.limbs[limb] = val;
        bit_src += LIMB_BITS;
    }
    return r;
}

// Write a BigInt back to 32 bytes (8 u32, little-endian). Only the lower 255 bits are written.
fn bigint_to_bytes_le(a: BigInt) -> array<u32, 8> {
    var out = array<u32, 8>(0u,0u,0u,0u,0u,0u,0u,0u);
    var bit_dst: u32 = 0u;

    for (var limb = 0u; limb < NUM_LIMBS; limb++) {
        let word_idx = bit_dst / 32u;
        let bit_off  = bit_dst % 32u;

        if (word_idx >= 8u) { break; }

        if (bit_off + LIMB_BITS <= 32u) {
            out[word_idx] |= (a.limbs[limb] & LIMB_MASK) << bit_off;
        } else {
            let lo_bits = 32u - bit_off;
            out[word_idx] |= (a.limbs[limb] & LIMB_MASK) << bit_off;
            if (word_idx + 1u < 8u) {
                out[word_idx + 1u] |= (a.limbs[limb] >> lo_bits);
            }
        }
        bit_dst += LIMB_BITS;
    }
    return out;
}
