// SHA-512 primitives for WebGPU/WGSL.
// Adapted from FuelLabs/wgpu-sigops (MIT OR Apache-2.0).
// Uses vec2<u32> to simulate u64 (WGSL has no native 64-bit integers).
// All words are big-endian: vec2<u32>[0] = high 32 bits, [1] = low 32 bits.

fn sha512_initial_hash() -> array<vec2<u32>, 8> {
    return array<vec2<u32>, 8>(
        vec2(0x6a09e667u, 0xf3bcc908u), vec2(0xbb67ae85u, 0x84caa73bu),
        vec2(0x3c6ef372u, 0xfe94f82bu), vec2(0xa54ff53au, 0x5f1d36f1u),
        vec2(0x510e527fu, 0xade682d1u), vec2(0x9b05688cu, 0x2b3e6c1fu),
        vec2(0x1f83d9abu, 0xfb41bd6bu), vec2(0x5be0cd19u, 0x137e2179u),
    );
}

fn sha512_round_constants() -> array<vec2<u32>, 80> {
    return array<vec2<u32>, 80>(
        vec2(0x428a2f98u, 0xd728ae22u), vec2(0x71374491u, 0x23ef65cdu),
        vec2(0xb5c0fbcfu, 0xec4d3b2fu), vec2(0xe9b5dba5u, 0x8189dbbcu),
        vec2(0x3956c25bu, 0xf348b538u), vec2(0x59f111f1u, 0xb605d019u),
        vec2(0x923f82a4u, 0xaf194f9bu), vec2(0xab1c5ed5u, 0xda6d8118u),
        vec2(0xd807aa98u, 0xa3030242u), vec2(0x12835b01u, 0x45706fbeu),
        vec2(0x243185beu, 0x4ee4b28cu), vec2(0x550c7dc3u, 0xd5ffb4e2u),
        vec2(0x72be5d74u, 0xf27b896fu), vec2(0x80deb1feu, 0x3b1696b1u),
        vec2(0x9bdc06a7u, 0x25c71235u), vec2(0xc19bf174u, 0xcf692694u),
        vec2(0xe49b69c1u, 0x9ef14ad2u), vec2(0xefbe4786u, 0x384f25e3u),
        vec2(0x0fc19dc6u, 0x8b8cd5b5u), vec2(0x240ca1ccu, 0x77ac9c65u),
        vec2(0x2de92c6fu, 0x592b0275u), vec2(0x4a7484aau, 0x6ea6e483u),
        vec2(0x5cb0a9dcu, 0xbd41fbd4u), vec2(0x76f988dau, 0x831153b5u),
        vec2(0x983e5152u, 0xee66dfabu), vec2(0xa831c66du, 0x2db43210u),
        vec2(0xb00327c8u, 0x98fb213fu), vec2(0xbf597fc7u, 0xbeef0ee4u),
        vec2(0xc6e00bf3u, 0x3da88fc2u), vec2(0xd5a79147u, 0x930aa725u),
        vec2(0x06ca6351u, 0xe003826fu), vec2(0x14292967u, 0x0a0e6e70u),
        vec2(0x27b70a85u, 0x46d22ffcu), vec2(0x2e1b2138u, 0x5c26c926u),
        vec2(0x4d2c6dfcu, 0x5ac42aedu), vec2(0x53380d13u, 0x9d95b3dfu),
        vec2(0x650a7354u, 0x8baf63deu), vec2(0x766a0abbu, 0x3c77b2a8u),
        vec2(0x81c2c92eu, 0x47edaee6u), vec2(0x92722c85u, 0x1482353bu),
        vec2(0xa2bfe8a1u, 0x4cf10364u), vec2(0xa81a664bu, 0xbc423001u),
        vec2(0xc24b8b70u, 0xd0f89791u), vec2(0xc76c51a3u, 0x0654be30u),
        vec2(0xd192e819u, 0xd6ef5218u), vec2(0xd6990624u, 0x5565a910u),
        vec2(0xf40e3585u, 0x5771202au), vec2(0x106aa070u, 0x32bbd1b8u),
        vec2(0x19a4c116u, 0xb8d2d0c8u), vec2(0x1e376c08u, 0x5141ab53u),
        vec2(0x2748774cu, 0xdf8eeb99u), vec2(0x34b0bcb5u, 0xe19b48a8u),
        vec2(0x391c0cb3u, 0xc5c95a63u), vec2(0x4ed8aa4au, 0xe3418acbu),
        vec2(0x5b9cca4fu, 0x7763e373u), vec2(0x682e6ff3u, 0xd6b2b8a3u),
        vec2(0x748f82eeu, 0x5defb2fcu), vec2(0x78a5636fu, 0x43172f60u),
        vec2(0x84c87814u, 0xa1f0ab72u), vec2(0x8cc70208u, 0x1a6439ecu),
        vec2(0x90befffau, 0x23631e28u), vec2(0xa4506cebu, 0xde82bde9u),
        vec2(0xbef9a3f7u, 0xb2c67915u), vec2(0xc67178f2u, 0xe372532bu),
        vec2(0xca273eceu, 0xea26619cu), vec2(0xd186b8c7u, 0x21c0c207u),
        vec2(0xeada7dd6u, 0xcde0eb1eu), vec2(0xf57d4f7fu, 0xee6ed178u),
        vec2(0x06f067aau, 0x72176fbau), vec2(0x0a637dc5u, 0xa2c898a6u),
        vec2(0x113f9804u, 0xbef90daeu), vec2(0x1b710b35u, 0x131c471bu),
        vec2(0x28db77f5u, 0x23047d84u), vec2(0x32caab7bu, 0x40c72493u),
        vec2(0x3c9ebe0au, 0x15c9bebcu), vec2(0x431d67c4u, 0x9c100d4cu),
        vec2(0x4cc5d4beu, 0xcb3e42b6u), vec2(0x597f299cu, 0xfc657e2au),
        vec2(0x5fcb6fabu, 0x3ad6faecu), vec2(0x6c44198cu, 0x4a475817u),
    );
}

fn sha512_not(a: vec2<u32>) -> vec2<u32> { return vec2(~a[0], ~a[1]); }
fn sha512_xor(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> { return vec2(a[0] ^ b[0], a[1] ^ b[1]); }
fn sha512_and(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> { return vec2(a[0] & b[0], a[1] & b[1]); }

// Right shift of a 64-bit value by num_bits (1–7 only; mask 0x7F is sufficient for SHA-512).
// Overflow from the << (32 - num_bits) term naturally drops extra bits for num_bits < 7.
fn sha512_shr(a: vec2<u32>, num_bits: u32) -> vec2<u32> {
    if (num_bits == 0u) { return a; }
    let new_high = a[0] >> num_bits;
    let carry    = (a[0] & 0x7fu) << (32u - num_bits);
    let new_low  = (a[1] >> num_bits) | carry;
    return vec2(new_high, new_low);
}

fn sha512_add(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
    let low  = a[1] + b[1];
    let carry = select(0u, 1u, low < a[1]);
    return vec2(a[0] + b[0] + carry, low);
}

fn sha512_rotr(n: vec2<u32>, b: u32) -> vec2<u32> {
    let bits = b % 64u;
    if (bits < 32u) {
        return vec2(
            (n[0] >> bits) | (n[1] << (32u - bits)),
            (n[1] >> bits) | (n[0] << (32u - bits)),
        );
    } else {
        let s = bits - 32u;
        return vec2(
            (n[1] >> s) | (n[0] << (32u - s)),
            (n[0] >> s) | (n[1] << (32u - s)),
        );
    }
}

// SHA-512 of a 32-byte input (Ed25519 seed / key derivation).
// Input: 8 big-endian u32s (bytes 0–3 packed into input_words[0], etc.).
// Output: 16 big-endian u32s — result[2i] = high32, result[2i+1] = low32 of word i.
fn sha512_32(input_words: ptr<function, array<u32, 8>>) -> array<u32, 16> {
    // Build padded 128-byte block as 32 big-endian u32s.
    // 32 bytes data | 0x80 byte | zeros | 128-bit length (256 bits = 0x100)
    var m = array<u32, 32>();
    for (var i = 0u; i < 8u; i++) { m[i] = (*input_words)[i]; }
    m[8]  = 0x80000000u; // padding bit immediately after 32 bytes of data
    // m[9..27] stay zero
    // m[28..30] stay zero (high 96 bits of 128-bit length = 0)
    m[31] = 256u;        // low 32 bits of 128-bit length = 256 bits

    var rc   = sha512_round_constants();
    var h    = sha512_initial_hash();
    var w    = array<u32, 160>();

    for (var i = 0u; i < 32u; i++) { w[i] = m[i]; }

    for (var i = 16u; i < 80u; i++) {
        let i2    = i * 2u;
        let wm15  = vec2(w[i2 - 30u], w[i2 - 29u]);
        let wm2   = vec2(w[i2 -  4u], w[i2 -  3u]);
        let wm16  = vec2(w[i2 - 32u], w[i2 - 31u]);
        let wm7   = vec2(w[i2 - 14u], w[i2 - 13u]);
        let s0    = sha512_xor(sha512_xor(sha512_rotr(wm15, 1u), sha512_rotr(wm15, 8u)), sha512_shr(wm15, 7u));
        let s1    = sha512_xor(sha512_xor(sha512_rotr(wm2, 19u), sha512_rotr(wm2, 61u)), sha512_shr(wm2,  6u));
        let wi    = sha512_add(sha512_add(sha512_add(wm16, s0), wm7), s1);
        w[i2]     = wi[0];
        w[i2 + 1u] = wi[1];
    }

    var a = h[0]; var b = h[1]; var c = h[2]; var d = h[3];
    var e = h[4]; var f = h[5]; var g = h[6]; var hh = h[7];

    for (var i = 0u; i < 80u; i++) {
        let s1   = sha512_xor(sha512_xor(sha512_rotr(e, 14u), sha512_rotr(e, 18u)), sha512_rotr(e, 41u));
        let ch   = sha512_xor(sha512_and(e, f), sha512_and(sha512_not(e), g));
        let i2   = i * 2u;
        let t1   = sha512_add(sha512_add(sha512_add(sha512_add(hh, s1), ch), rc[i]), vec2(w[i2], w[i2 + 1u]));
        let s0   = sha512_xor(sha512_xor(sha512_rotr(a, 28u), sha512_rotr(a, 34u)), sha512_rotr(a, 39u));
        let maj  = sha512_xor(sha512_xor(sha512_and(a, b), sha512_and(a, c)), sha512_and(b, c));
        let t2   = sha512_add(s0, maj);
        hh = g; g = f; f = e;
        e = sha512_add(d, t1);
        d = c; c = b; b = a;
        a = sha512_add(t1, t2);
    }

    h[0] = sha512_add(h[0], a);  h[1] = sha512_add(h[1], b);
    h[2] = sha512_add(h[2], c);  h[3] = sha512_add(h[3], d);
    h[4] = sha512_add(h[4], e);  h[5] = sha512_add(h[5], f);
    h[6] = sha512_add(h[6], g);  h[7] = sha512_add(h[7], hh);

    var result = array<u32, 16>();
    for (var i = 0u; i < 8u; i++) {
        result[i * 2u]       = h[i][0]; // high 32 bits
        result[i * 2u + 1u]  = h[i][1]; // low 32 bits
    }
    return result;
}
