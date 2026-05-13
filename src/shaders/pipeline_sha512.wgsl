// Compute pipeline: seeds[] -> SHA-512 digests[].
// Each thread processes one 32-byte seed.
// Concatenate after sha512.wgsl (uses sha512_32, sha512_add, etc.).
//
// Buffer layout:
//   binding 0: array<u32> seeds    — N×8 u32s, raw byte order (little-endian u32s from JS)
//   binding 1: array<u32> digests  — N×16 u32s, raw byte order (little-endian u32s for JS)

@group(0) @binding(0) var<storage, read>       seeds:   array<u32>;
@group(0) @binding(1) var<storage, read_write> digests: array<u32>;

// Swap byte order of a u32: [b0,b1,b2,b3] <-> [b3,b2,b1,b0].
// Used to convert between GPU-native little-endian and SHA-512's big-endian words.
fn byteswap32(x: u32) -> u32 {
    return ((x & 0xFF000000u) >> 24u)
         | ((x & 0x00FF0000u) >>  8u)
         | ((x & 0x0000FF00u) <<  8u)
         | ((x & 0x000000FFu) << 24u);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let total = arrayLength(&seeds) / 8u;
    let idx   = gid.x;
    if (idx >= total) { return; }

    let seed_base   = idx * 8u;
    let digest_base = idx * 16u;

    // Load seed as big-endian u32s for SHA-512 (byteswap from little-endian buffer).
    var input_words: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) {
        input_words[i] = byteswap32(seeds[seed_base + i]);
    }

    let digest = sha512_32(&input_words);

    // Write digest as little-endian u32s (byteswap from SHA-512 big-endian output).
    for (var i = 0u; i < 16u; i++) {
        digests[digest_base + i] = byteswap32(digest[i]);
    }
}
