// Compute pipeline: clamped scalars[] -> compressed pubkeys[].
// Each thread processes one 32-byte scalar.
// Concatenate after bigint.wgsl, ff.wgsl, and edwards25519.wgsl.
//
// Buffer layout:
//   binding 0: array<u32> in_scalars — N×8 u32s, little-endian, already clamped
//   binding 1: array<u32> out        — N×8 u32s, compressed public key, little-endian

@group(0) @binding(0) var<storage, read>       in_scalars: array<u32>;
@group(0) @binding(1) var<storage, read_write> out:        array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let total = arrayLength(&in_scalars) / 8u;
    let idx   = gid.x;
    if (idx >= total) { return; }

    let scalar_base = idx * 8u;
    let out_base    = idx * 8u;

    var scalar_bytes: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) {
        scalar_bytes[i] = in_scalars[scalar_base + i];
    }

    let G      = PointExtended(curve_base_x(), curve_base_y(), bigint_one(), field_mul(curve_base_x(), curve_base_y()));
    let pubkey = scalar_mult(&scalar_bytes, G);
    let bytes  = point_compress(pubkey);

    for (var i = 0u; i < 8u; i++) {
        out[out_base + i] = bytes[i];
    }
}
