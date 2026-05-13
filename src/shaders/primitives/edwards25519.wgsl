// Edwards25519 curve constants.
// Must be included AFTER bigint.wgsl and ff.wgsl.
//
// Curve equation (twisted Edwards): -x² + y² = 1 + d·x²·y²  over GF(2^255-19)
//
// d = -121665/121666 mod p
//   = 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3
//
// Base point G = (BASE_X, BASE_Y):
//   BASE_Y = 4/5 mod p
//           = 0x6666666666666666666666666666666666666666666666666666666666666658
//   BASE_X is the even square root of (y²-1)/(d·y²+1) mod p
//           = 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a

// d = -121665/121666 mod p
fn curve_d() -> BigInt {
    return BigInt(array<u32, 20>(
        0x18A3u, 0x1ACBu, 0x1284u, 0x169Bu, 0x175Eu,
        0x0C55u, 0x0507u, 0x09A8u, 0x100Au, 0x0003u,
        0x1A26u, 0x0EF3u, 0x0797u, 0x03A0u, 0x0E33u,
        0x1FCEu, 0x0B6Fu, 0x0771u, 0x00DBu, 0x00A4u,
    ));
}

// 2·d mod p — used in extended twisted Edwards addition.
fn curve_2d() -> BigInt {
    return BigInt(array<u32, 20>(
        0x1159u, 0x1597u, 0x0509u, 0x0D37u, 0x0EBDu,
        0x18ABu, 0x0A0Eu, 0x1350u, 0x0014u, 0x0007u,
        0x144Cu, 0x1DE7u, 0x0F2Eu, 0x0740u, 0x1C66u,
        0x1F9Cu, 0x16DFu, 0x0EE2u, 0x01B6u, 0x0048u,
    ));
}

// BASE_Y = 4/5 mod p  (y-coordinate of the base point G)
fn curve_base_y() -> BigInt {
    return BigInt(array<u32, 20>(
        0x0658u, 0x1333u, 0x1999u, 0x0CCCu, 0x0666u,
        0x1333u, 0x1999u, 0x0CCCu, 0x0666u, 0x1333u,
        0x1999u, 0x0CCCu, 0x0666u, 0x1333u, 0x1999u,
        0x0CCCu, 0x0666u, 0x1333u, 0x1999u, 0x00CCu,
    ));
}

// BASE_X (even square root, x & 1 == 0)
fn curve_base_x() -> BigInt {
    return BigInt(array<u32, 20>(
        0x151Au, 0x192Eu, 0x1823u, 0x0C5Au, 0x0C95u,
        0x13D9u, 0x1496u, 0x0C12u, 0x0CC7u, 0x0349u,
        0x1717u, 0x1BADu, 0x031Fu, 0x1271u, 0x1B02u,
        0x0A7Fu, 0x0D6Eu, 0x169Eu, 0x1A4Du, 0x0042u,
    ));
}
