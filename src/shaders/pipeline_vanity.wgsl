// Vanity pipeline: derive + GPU prefix/suffix filter + atomic hit buffer.
// Seeds that pass the filter are written to hit_seeds; hit_count tracks the total.
// CPU re-verifies all hits via noble for exact correctness.
//
// Concatenate after: sha512.wgsl, bigint.wgsl, ff.wgsl, edwards25519.wgsl
//
// Bindings:
//   0: in_seeds    — N×8 u32 LE seeds
//   1: g_table     — 255×24 u32 precomputed 2^i·G table (x[8]||y[8]||t[8] per point)
//   2: hit_count   — atomic<u32> hit counter (zeroed before dispatch)
//   3: hit_seeds   — N×8 u32 output seeds for hits
//   4: uniforms    — Uniforms struct (80 bytes)

struct Uniforms {
    L0:   vec4<u32>,   // L u32[0..3]  — base58 lower bound, LE for bigint_from_bytes_le
    L1:   vec4<u32>,   // L u32[4..7]
    H0:   vec4<u32>,   // H u32[0..3]  — base58 upper bound
    H1:   vec4<u32>,   // H u32[4..7]
    ctrl: vec4<u32>,   // [suffix_mod, suffix_val, has_prefix, has_suffix]
}

@group(0) @binding(0) var<storage, read>       in_seeds:  array<u32>;
@group(0) @binding(1) var<storage, read>       g_table:   array<u32>;
@group(0) @binding(2) var<storage, read_write> hit_count: atomic<u32>;
@group(0) @binding(3) var<storage, read_write> hit_seeds: array<u32>;
@group(0) @binding(4) var<uniform>             uniforms:  Uniforms;

fn byteswap32(x: u32) -> u32 {
    return ((x & 0xFF000000u) >> 24u)
         | ((x & 0x00FF0000u) >>  8u)
         | ((x & 0x0000FF00u) <<  8u)
         | ((x & 0x000000FFu) << 24u);
}

// Compare two 256-bit values stored as 8×u32 little-endian (word[0]=LSW, word[7]=MSW).
// Returns a >= b.
fn le256_gte(a: ptr<function, array<u32, 8>>, b: ptr<function, array<u32, 8>>) -> bool {
    for (var i = 7u; ; i -= 1u) {
        if ((*a)[i] > (*b)[i]) { return true; }
        if ((*a)[i] < (*b)[i]) { return false; }
        if (i == 0u) { break; }
    }
    return true;
}

// value mod m, processing BigInt limbs from MSB (limbs[19]) to LSB (limbs[0]).
// Two-step shift avoids u32 overflow for m up to 58^4 = 11316496 (< 2^24).
// Math: (rem << 13 | limb) % m = ((rem*64 % m)*128 + limb) % m
fn bigint_mod_u32(a: BigInt, m: u32) -> u32 {
    var rem: u32 = 0u;
    for (var i = NUM_LIMBS; i > 0u; i--) {
        let r6 = (rem << 6u) % m;                       // rem*64 < 2^30 for m<2^24 ✓
        rem = ((r6 << 7u) | a.limbs[i - 1u]) % m;       // r6*128 < 2^31 ✓
    }
    return rem;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let total = arrayLength(&in_seeds) / 8u;
    let idx   = gid.x;
    if (idx >= total) { return; }

    let seed_base = idx * 8u;

    // Load seed as big-endian u32s for SHA-512.
    var input_words: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) {
        input_words[i] = byteswap32(in_seeds[seed_base + i]);
    }

    // SHA-512 → digest[0..7] = first 32 bytes (big-endian).
    let digest = sha512_32(&input_words);

    // Byteswap back to little-endian scalar.
    var scalar_bytes: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) {
        scalar_bytes[i] = byteswap32(digest[i]);
    }

    // RFC 8032 §5.1.5 clamping.
    scalar_bytes[0] &= 0xFFFFFFF8u;
    scalar_bytes[7] &= 0x7FFFFFFFu;
    scalar_bytes[7] |= 0x40000000u;

    // Fixed-base scalar multiplication via precomputed 2^i·G table.
    // g_table point i: u32s [i*24 .. i*24+7]=x, [i*24+8..+15]=y, [i*24+16..+23]=t=x·y (LE).
    var result = point_identity();
    for (var i = 0u; i < 255u; i++) {
        let word    = i >> 5u;
        let bit_pos = i & 31u;
        let b       = (scalar_bytes[word] >> bit_pos) & 1u;

        if (b != 0u) {
            let tbl_base = i * 24u;
            var px: array<u32, 8>;
            var py: array<u32, 8>;
            var pt: array<u32, 8>;
            for (var j = 0u; j < 8u; j++) {
                px[j] = g_table[tbl_base + j];
                py[j] = g_table[tbl_base + 8u  + j];
                pt[j] = g_table[tbl_base + 16u + j];
            }
            let bx = bigint_from_bytes_le(&px);
            let by = bigint_from_bytes_le(&py);
            let bt = bigint_from_bytes_le(&pt);
            result = point_add(result, PointExtended(bx, by, bigint_one(), bt));
        }
    }

    // Compress pubkey to 32-byte LE representation.
    let bytes = point_compress(result);

    // Convert to base58 numeric representation (treat LE bytes as BE integer).
    // rev[i] = byteswap32(bytes[7-i]) reverses the byte order so that
    // bigint_from_bytes_le(&rev) == base58_encode_value(pubkey).
    var rev: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) {
        rev[i] = byteswap32(bytes[7u - i]);
    }
    // Prefix check: L ≤ pubkey_be ≤ H.
    // rev[] and L/H uniforms are all in LE256 format (word[0]=LSW, word[7]=MSW),
    // so we compare directly without converting to the 20-limb BigInt representation.
    if (uniforms.ctrl.z != 0u) {
        var L_u32 = array<u32, 8>(
            uniforms.L0.x, uniforms.L0.y, uniforms.L0.z, uniforms.L0.w,
            uniforms.L1.x, uniforms.L1.y, uniforms.L1.z, uniforms.L1.w
        );
        var H_u32 = array<u32, 8>(
            uniforms.H0.x, uniforms.H0.y, uniforms.H0.z, uniforms.H0.w,
            uniforms.H1.x, uniforms.H1.y, uniforms.H1.z, uniforms.H1.w
        );
        if (!le256_gte(&rev, &L_u32) || !le256_gte(&H_u32, &rev)) {
            return;
        }
    }

    // Suffix check: pubkey_be mod suffix_mod == suffix_val.
    if (uniforms.ctrl.w != 0u) {
        var pubkey_be = bigint_from_bytes_le(&rev);
        let rem = bigint_mod_u32(pubkey_be, uniforms.ctrl.x);
        if (rem != uniforms.ctrl.y) { return; }
    }

    // Write hit seed atomically.
    let hit_idx = atomicAdd(&hit_count, 1u);
    let n = arrayLength(&hit_seeds) / 8u;
    if (hit_idx < n) {
        let out_base = hit_idx * 8u;
        for (var j = 0u; j < 8u; j++) {
            hit_seeds[out_base + j] = in_seeds[seed_base + j];
        }
    }
}
