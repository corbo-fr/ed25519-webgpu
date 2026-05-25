// Fused pipeline: seeds[] -> compressed pubkeys[] in a single GPU dispatch.
// No CPU round-trip: SHA-512 + RFC 8032 clamping + scalar_mult all on GPU.
//
// Concatenate after: sha512.wgsl, bigint.wgsl, ff.wgsl, edwards25519.wgsl
//
// Buffer layout:
//   binding 0: array<u32> in_seeds    — N×8 u32s, little-endian u32s from JS
//   binding 1: array<u32> out_pubkeys — N×8 u32s, compressed public key, little-endian

@group(0) @binding(0) var<storage, read>       in_seeds:    array<u32>;
@group(0) @binding(1) var<storage, read_write> out_pubkeys: array<u32>;

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

    // Scalar multiplication with base point G.
    let G      = PointExtended(curve_base_x(), curve_base_y(), bigint_one(), field_mul(curve_base_x(), curve_base_y()));
    let pubkey = scalar_mult(&scalar_bytes, G);

    // Compress and write output.
    let bytes = point_compress(pubkey);
    for (var i = 0u; i < 8u; i++) {
        out_pubkeys[out_base + i] = bytes[i];
    }
}
