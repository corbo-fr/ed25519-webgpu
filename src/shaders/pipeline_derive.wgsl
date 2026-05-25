// Fused pipeline: seeds[] -> compressed pubkeys[] in a single GPU dispatch.
// No CPU round-trip: SHA-512 + RFC 8032 clamping + fixed-base scalar_mult all on GPU.
//
// Concatenate after: sha512.wgsl, bigint.wgsl, ff.wgsl, edwards25519.wgsl
//
// Buffer layout:
//   binding 0: array<u32> in_seeds    — N×8 u32s, little-endian
//   binding 1: array<u32> out_pubkeys — N×8 u32s, compressed public key, little-endian
//   binding 2: array<u32> g_table     — 255×16 u32s (x[8 LE] || y[8 LE] per point)

@group(0) @binding(0) var<storage, read>       in_seeds:    array<u32>;
@group(0) @binding(1) var<storage, read_write> out_pubkeys: array<u32>;
@group(0) @binding(2) var<storage, read>       g_table:     array<u32>;

fn byteswap32(x: u32) -> u32 {
    return ((x & 0xFF000000u) >> 24u)
         | ((x & 0x00FF0000u) >>  8u)
         | ((x & 0x0000FF00u) <<  8u)
         | ((x & 0x000000FFu) << 24u);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let total = arrayLength(&in_seeds) / 8u;
    let idx   = gid.x;
    if (idx >= total) { return; }

    let seed_base = idx * 8u;
    let out_base  = idx * 8u;

    // Load seed as big-endian u32s for SHA-512 (byteswap from little-endian buffer).
    var input_words: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) {
        input_words[i] = byteswap32(in_seeds[seed_base + i]);
    }

    // SHA-512 → 16 big-endian u32s; words 0-7 = first 32 bytes = scalar.
    let digest = sha512_32(&input_words);

    // Byteswap first 8 digest words back to little-endian to get the scalar.
    var scalar_bytes: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) {
        scalar_bytes[i] = byteswap32(digest[i]);
    }

    // RFC 8032 §5.1.5 clamping.
    scalar_bytes[0] &= 0xFFFFFFF8u; // clear bits 0-2 of byte 0
    scalar_bytes[7] &= 0x7FFFFFFFu; // clear bit 7 of byte 31
    scalar_bytes[7] |= 0x40000000u; // set   bit 6 of byte 31

    // Fixed-base scalar multiplication using precomputed 2^i·G table.
    // g_table point i: u32s [i*16 .. i*16+7] = x, [i*16+8 .. i*16+15] = y (LE).
    var result = point_identity();
    for (var i = 0u; i < 255u; i++) {
        let word    = i >> 5u;
        let bit_pos = i & 31u;
        let b       = (scalar_bytes[word] >> bit_pos) & 1u;

        let tbl_base = i * 16u;
        var px: array<u32, 8>;
        var py: array<u32, 8>;
        for (var j = 0u; j < 8u; j++) {
            px[j] = g_table[tbl_base + j];
            py[j] = g_table[tbl_base + 8u + j];
        }
        var bx = bigint_from_bytes_le(&px);
        var by = bigint_from_bytes_le(&py);

        // Branch-free select: if bit=0, substitute identity point (0, 1).
        for (var j = 0u; j < NUM_LIMBS; j++) {
            bx.limbs[j] = select(0u, bx.limbs[j], b != 0u);
            let id_y     = select(0u, 1u, j == 0u);
            by.limbs[j]  = select(id_y, by.limbs[j], b != 0u);
        }
        let p_t   = field_mul(bx, by);
        let p_ext = PointExtended(bx, by, bigint_one(), p_t);
        result    = point_add(result, p_ext);
    }

    // Compress and write output.
    let bytes = point_compress(result);
    for (var i = 0u; i < 8u; i++) {
        out_pubkeys[out_base + i] = bytes[i];
    }
}
