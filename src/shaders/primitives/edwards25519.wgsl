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

// Extended twisted Edwards coordinates: (X:Y:Z:T) with x=X/Z, y=Y/Z, x*y=T/Z.
struct PointExtended {
    X: BigInt,
    Y: BigInt,
    Z: BigInt,
    T: BigInt,
}

// Identity point: (0 : 1 : 1 : 0)  i.e. affine (0, 1).
fn point_identity() -> PointExtended {
    return PointExtended(bigint_zero(), bigint_one(), bigint_one(), bigint_zero());
}

// Unified addition — Hisil-Wong-Carter-Dawson 2008, add-2008-hwcd, a = -1.
//
// A = X1·X2        B = Y1·Y2
// C = T1·T2·(2d)   D = Z1·Z2
// E = (X1+Y1)·(X2+Y2) - A - B
// F = D-C          G = D+C        H = B+A
// X3=E·F  Y3=G·H  Z3=F·G  T3=E·H
fn point_add(p: PointExtended, q: PointExtended) -> PointExtended {
    let A  = field_mul(p.X, q.X);
    let B  = field_mul(p.Y, q.Y);
    let C  = field_mul(field_mul(p.T, q.T), curve_2d());
    let D  = field_mul(p.Z, q.Z);
    let E  = field_sub(field_sub(field_mul(field_add(p.X, p.Y), field_add(q.X, q.Y)), A), B);
    let F  = field_sub(D, C);
    let G  = field_add(D, C);
    let H  = field_add(B, A);
    return PointExtended(
        field_mul(E, F),
        field_mul(G, H),
        field_mul(F, G),
        field_mul(E, H),
    );
}
