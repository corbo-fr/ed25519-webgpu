// Field arithmetic over GF(p), p = 2^255 - 19.
// Must be included AFTER bigint.wgsl.
//
// Reduction identity: 2^255 ≡ 19 mod p → 2^260 = 32·2^255 ≡ 32·19 = 608 mod p.
// Wide product fold: limb[k] × 2^(13k) ≡ limb[k] × 608 × 2^(13(k-20)) mod p for k ≥ 20.

// p = 2^255 - 19 in 20 × 13-bit LE limbs.
//   limb  0:     2^13 - 19 = 8173 = 0x1FED   (bits 0..12, from 0xFFFFFFED LE word)
//   limbs 1..18: 0x1FFF = 8191               (bits 13..246 of p are all 1)
//   limb  19:    255    = 0x00FF              (bits 247..254; bit 255 = 0)
fn field_p() -> BigInt {
    return BigInt(array<u32, 20>(
        0x1FEDu, 0x1FFFu, 0x1FFFu, 0x1FFFu, 0x1FFFu,
        0x1FFFu, 0x1FFFu, 0x1FFFu, 0x1FFFu, 0x1FFFu,
        0x1FFFu, 0x1FFFu, 0x1FFFu, 0x1FFFu, 0x1FFFu,
        0x1FFFu, 0x1FFFu, 0x1FFFu, 0x1FFFu, 0x00FFu,
    ));
}

// Reduce a 40-limb wide product mod p.
// Two fold passes suffice: after pass 1 the carry into limb 20 is at most 1;
// pass 2 folds that single limb (adds ≤ 608 to limb 0, no further spillover).
fn field_reduce_wide(a: BigIntWide) -> BigInt {
    var w: BigIntWide = a;
    let p = field_p();

    // Fold pass 1: for k = 20..39, add w[k]*608 to w[k-20].
    for (var k = 20u; k < 40u; k++) {
        w.limbs[k - 20u] += w.limbs[k] * 608u;
        w.limbs[k] = 0u;
    }
    // Carry propagation — spill may reach limb 20 or 21.
    var carry: u32 = 0u;
    for (var i = 0u; i < 40u; i++) {
        let s = w.limbs[i] + carry;
        w.limbs[i] = s & LIMB_MASK;
        carry = s >> LIMB_BITS;
    }

    // Fold pass 2: use 2^255 ≡ 19 mod p to fold bits 255..259 (+ limb-20 carry).
    // Limb 19 holds bits 247..259; bit 255 is at position 8 within that limb.
    // h = number of 2^255 units in the 260-bit value.
    let h = (w.limbs[19] >> 8u) + w.limbs[20] * 32u;
    w.limbs[19] &= 0xFFu;
    w.limbs[20] = 0u;
    w.limbs[0] += h * 19u;
    carry = 0u;
    for (var i = 0u; i < 20u; i++) {
        let s = w.limbs[i] + carry;
        w.limbs[i] = s & LIMB_MASK;
        carry = s >> LIMB_BITS;
    }

    var r: BigInt;
    for (var i = 0u; i < NUM_LIMBS; i++) {
        r.limbs[i] = w.limbs[i];
    }
    if (bigint_gte(r, p)) {
        r = bigint_sub(r, p);
    }
    return r;
}

// (a + b) mod p. a, b must be in [0, p).
fn field_add(a: BigInt, b: BigInt) -> BigInt {
    let p = field_p();
    var r = bigint_add(a, b);
    if (bigint_gte(r, p)) {
        r = bigint_sub(r, p);
    }
    return r;
}

// (a - b) mod p. a, b must be in [0, p).
fn field_sub(a: BigInt, b: BigInt) -> BigInt {
    let p = field_p();
    if (bigint_gte(a, b)) {
        return bigint_sub(a, b);
    }
    // a < b: result = p - (b - a).
    return bigint_sub(p, bigint_sub(b, a));
}

// (a * b) mod p.
fn field_mul(a: BigInt, b: BigInt) -> BigInt {
    return field_reduce_wide(bigint_mul(a, b));
}

// a^2 mod p — dedicated schoolbook squaring, ~1.9× faster than field_mul(a, a).
fn field_sq(a: BigInt) -> BigInt {
    return field_reduce_wide(bigint_sq(a));
}

// base^exp mod p — binary square-and-multiply, LSB-first within each 32-bit word.
// exp is 256 bits packed as 8 LE u32 words (exp[0] = least-significant word).
fn field_pow(base: BigInt, exp: ptr<function, array<u32, 8>>) -> BigInt {
    var result = bigint_one();
    var b = base;
    for (var w = 0u; w < 8u; w++) {
        let word = (*exp)[w];
        for (var bit = 0u; bit < 32u; bit++) {
            if (((word >> bit) & 1u) != 0u) {
                result = field_mul(result, b);
            }
            b = field_sq(b);
        }
    }
    return result;
}

// Repeated squaring: returns a^(2^n).
fn field_sq_n(a: BigInt, n: u32) -> BigInt {
    var r = a;
    for (var i = 0u; i < n; i++) {
        r = field_sq(r);
    }
    return r;
}

// a^(p-2) mod p — Bernstein addition chain for p = 2^255-19, p-2 = 2^255-21.
// 11 field_mul + 254 field_sq  (vs ~256 sq + ~253 mul with binary powering: ~2× faster).
fn field_inv(z: BigInt) -> BigInt {
    let z2      = field_sq(z);                   // z^2
    let z4      = field_sq(z2);                  // z^4
    let z8      = field_sq(z4);                  // z^8
    let z9      = field_mul(z,    z8);            // z^9
    let z11     = field_mul(z2,   z9);            // z^11
    let z22     = field_sq(z11);                 // z^22
    let z_2_5   = field_mul(z9,   z22);           // z^(2^5  - 1)
    let t1      = field_sq_n(z_2_5,   5u);        // z^(2^10 - 2^5)
    let z_2_10  = field_mul(t1,  z_2_5);          // z^(2^10 - 1)
    let t2      = field_sq_n(z_2_10,  10u);       // z^(2^20 - 2^10)
    let z_2_20  = field_mul(t2,  z_2_10);         // z^(2^20 - 1)
    let t3      = field_sq_n(z_2_20,  20u);       // z^(2^40 - 2^20)
    let z_2_40  = field_mul(t3,  z_2_20);         // z^(2^40 - 1)
    let t4      = field_sq_n(z_2_40,  10u);       // z^(2^50 - 2^10)
    let z_2_50  = field_mul(t4,  z_2_10);         // z^(2^50 - 1)
    let t5      = field_sq_n(z_2_50,  50u);       // z^(2^100 - 2^50)
    let z_2_100 = field_mul(t5,  z_2_50);         // z^(2^100 - 1)
    let t6      = field_sq_n(z_2_100, 100u);      // z^(2^200 - 2^100)
    let z_2_200 = field_mul(t6,  z_2_100);        // z^(2^200 - 1)
    let t7      = field_sq_n(z_2_200, 50u);       // z^(2^250 - 2^50)
    let z_2_250 = field_mul(t7,  z_2_50);         // z^(2^250 - 1)
    let t8      = field_sq_n(z_2_250, 5u);        // z^(2^255 - 2^5)
    return field_mul(t8, z11);                    // z^(2^255 - 21) = z^(p-2)
}

// Square root mod p. p ≡ 5 mod 8.
// Candidate: v = a^((p+3)/8) = a^(2^252-2).
// If v^2 == a  → return v.
// If v^2 == -a → multiply by i = 2^((p-1)/4) mod p, then return.
// Returns 0 if a has no square root (non-residue) — caller must check.
//
// (p+3)/8 = 2^252 - 2:  LE u32 [0xFFFFFFFE, 0xFFFFFFFF×6, 0x0FFFFFFF]
// (p-1)/4 = 2^253 - 5:  LE u32 [0xFFFFFFFB, 0xFFFFFFFF×6, 0x1FFFFFFF]
fn field_sqrt(u: BigInt) -> BigInt {
    var exp_a = array<u32, 8>(
        0xFFFFFFFEu, 0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu,
        0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu, 0x0FFFFFFFu,
    );
    var v = field_pow(u, &exp_a);

    let v2 = field_sq(v);
    if (bigint_eq(v2, u)) {
        return v;
    }
    let neg_u = field_sub(bigint_zero(), u);
    if (bigint_eq(v2, neg_u)) {
        // Multiply v by sqrt(-1) = 2^((p-1)/4) mod p.
        var two = bigint_one();
        two.limbs[0] = 2u;
        var exp_i = array<u32, 8>(
            0xFFFFFFFBu, 0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu,
            0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu, 0x1FFFFFFFu,
        );
        let i = field_pow(two, &exp_i);
        return field_mul(v, i);
    }
    return bigint_zero();
}
