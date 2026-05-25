# webgpu-ed25519 — Plan Optimisation Performance

**Contexte :** lib v0.1.0 fonctionnelle, intégrée dans `vanity_keypair_generator`.
Perf actuelle : ~65k gen/s (1 batch de 65536 keys ≈ 1s sur M-series).
Bottleneck principal : scalar_mult (255 double-and-add × 65536 en parallèle) + readback intermédiaire CPU↔GPU.

**Règle absolue :** 1 tâche atomique par message, s'arrêter après chaque fichier créé/modifié, attendre confirmation avant de continuer.

---

## Résumé des gains attendus

| Step | Perf estimée | Bottleneck éliminé |
|---|---|---|
| v0.1.0 (actuel) | ~65k gen/s | — |
| Step 1 (fused pipeline) | ~80k gen/s | readback intermédiaire SHA-512→CPU→scalar_mult |
| Step 2 (fixed-base scalar_mult) | ~180-200k gen/s | 255 doublings remplacés par table 2^i·G |
| Step 3 (GPU prefix/suffix matching) | ~350-500k gen/s | CPU base58 encode × 65536 + readback non-hits |

---

## Step 1 — Fused pipeline : SHA-512 + scalar_mult en 1 seul dispatch GPU

**Problème actuel :** `deriveBatch` fait SHA-512 dispatch → readback CPU 4MB → CPU extrait scalars → scalar_mult dispatch → readback 2MB. Le readback intermédiaire de 4MB est inutile.

**Solution :** nouveau shader qui chaîne SHA-512 + clamping + scalar_mult sans sortir du GPU.

### Logique du shader `pipeline_derive.wgsl`

Pour chaque thread (1 thread = 1 key) :

```
1. Charger seed depuis in_seeds[idx*8..(idx+1)*8] (u32 little-endian)
2. byteswap32 chaque u32 → big-endian pour SHA-512
3. sha512_32(&input_words) → digest[16] (big-endian)
4. Pour i=0..7 : scalar[i] = byteswap32(digest[i])  ← first 32 bytes, remis en LE
5. Clamping RFC 8032 :
     scalar[0] &= 0xFFFFFFF8u   (clear bits 0-2 de byte 0)
     scalar[7] &= 0x7FFFFFFFu   (clear bit 7 de byte 31)
     scalar[7] |= 0x40000000u   (set bit 6 de byte 31)
6. G = PointExtended(curve_base_x(), curve_base_y(), bigint_one(), field_mul(base_x, base_y))
7. pubkey = scalar_mult(&scalar, G)
8. bytes = point_compress(pubkey)
9. Écrire bytes dans out_pubkeys[idx*8..(idx+1)*8]
```

Bindings :
- `@binding(0) in_seeds: array<u32>`  — N×8 u32s (seeds)
- `@binding(1) out_pubkeys: array<u32>` — N×8 u32s (pubkeys compressées)

Source WGSL = sha512.wgsl + bigint.wgsl + ff.wgsl + edwards25519.wgsl + pipeline_derive.wgsl

### Fichiers à créer/modifier

1. **NEW** `src/shaders/pipeline_derive.wgsl`
2. **MODIFY** `src/core/pipelines.ts` — ajouter `derive` pipeline (garder sha512 + scalarMult existants pour compatibilité)
3. **MODIFY** `src/core/derive.ts` — `deriveBatchFused()` (1 dispatch, 1 readback), utilisée par `derivePublicKeys`
4. Vérifier `test/gpu/derive/noble-equivalence.test.ts` — 0 mismatch

### Gate de sortie

```bash
pnpm test:layer2   # RFC 8032 exact + 10k noble — 0 mismatch
```

### Arrêt — commit/push

```bash
git add -A
git commit -m "perf: fused sha512+scalar-mult pipeline, single GPU dispatch"
git push
```

**Prompt session suivante :**
```
Lis /Users/trixky/Projects/webgpu-ed25519/PLAN_OPTIM.md et implémente le Step 2.
Le Step 1 (fused pipeline) est terminé et commité.
```

---

## Step 2 — Fixed-base scalar_mult (table précomputée des 2^i·G)

**Problème actuel :** `scalar_mult` fait 255 doublings + ~128 additions = ~3200 opérations de champ par key. Les doublings sont inutiles pour un base point fixe.

**Solution :** précalculer [G, 2G, 4G, …, 2^254·G] une fois, stocker dans un buffer GPU. Le shader ne fait plus que ~128 additions conditionnelles (aucun doubling).

**Gain théorique :** éliminer 255 doublings (~2040 ops) → gain ~2.5-3x sur scalar_mult, soit ~2x global.

### Étape A — CPU : calculer la table

Nouveau fichier `src/core/table.ts` :

```ts
import { ed25519 } from '@noble/curves/ed25519';

// Retourne 255 points affines 2^i*G encodés en LE bytes : x[32] || y[32]
export function computeGTable(): Uint8Array {
    const table = new Uint8Array(255 * 64);
    let p = ed25519.ExtendedPoint.BASE;
    for (let i = 0; i < 255; i++) {
        const aff = p.toAffine();
        const xBytes = leBytes(aff.x, 32);
        const yBytes = leBytes(aff.y, 32);
        table.set(xBytes, i * 64);
        table.set(yBytes, i * 64 + 32);
        p = p.double();
    }
    return table;
}

function leBytes(n: bigint, size: number): Uint8Array {
    const buf = new Uint8Array(size);
    let v = n;
    for (let i = 0; i < size; i++) {
        buf[i] = Number(v & 0xFFn);
        v >>= 8n;
    }
    return buf;
}
```

### Étape B — WGSL : scalar_mult_fixed

Dans `edwards25519.wgsl`, ajouter après `scalar_mult` :

```wgsl
// g_table: binding 2, array<u32>, 255 × 16 u32s (x[8] LE || y[8] LE par point)
// Déclaré dans le pipeline entry point, pas ici.

fn scalar_mult_fixed(
    scalar: ptr<function, array<u32, 8>>,
    g_table: ptr<function, array<u32, 4080>>  // ← passé en argument n'est pas possible en WGSL storage
) -> PointExtended { ... }
```

Note : les storage buffers ne se passent pas en argument de fonction en WGSL. La solution est de déclarer `g_table` au niveau module dans `pipeline_derive.wgsl` et d'inliner la logique dans le `@compute` entry point, ou de créer une fonction séparée dans le fichier pipeline.

**Logique de la fonction (inlinée dans le @compute) :**

```wgsl
var result = point_identity();
for (var i = 0u; i < 255u; i++) {
    let word = i >> 5u;
    let bit_pos = i & 31u;
    let b = ((*scalar)[word] >> bit_pos) & 1u;

    let tbl_base = i * 16u;  // 16 u32s par point (8 pour x, 8 pour y)
    var px: array<u32, 8>;
    var py: array<u32, 8>;
    for (var j = 0u; j < 8u; j++) {
        px[j] = g_table[tbl_base + j];
        py[j] = g_table[tbl_base + 8u + j];
    }
    var bx = bigint_from_bytes_le(&px);
    var by = bigint_from_bytes_le(&py);

    // Branch-free : si bit=0, utiliser l'identité (0, 1) pour ne pas modifier result
    for (var j = 0u; j < NUM_LIMBS; j++) {
        bx.limbs[j] = select(0u, bx.limbs[j], b != 0u);
        let id_y = select(0u, 1u, j == 0u);  // BigInt one : limbs[0]=1, autres=0
        by.limbs[j] = select(id_y, by.limbs[j], b != 0u);
    }
    let p_t = field_mul(bx, by);
    let p_ext = PointExtended(bx, by, bigint_one(), p_t);
    result = point_add(result, p_ext);
}
// result = pubkey non compressé
```

### Fichiers à créer/modifier

1. **NEW** `src/core/table.ts` — `computeGTable(): Uint8Array`
2. **MODIFY** `src/core/pipelines.ts` — passer `gTableBuf` comme binding 2
3. **MODIFY** `src/shaders/pipeline_derive.wgsl` — ajouter binding `g_table`, utiliser fixed-base loop
4. **MODIFY** `src/index.ts` — `Ed25519GPU.create()` appelle `computeGTable()` + crée `gTableBuf` (storage readonly)
5. Garder `scalar_mult` existant dans edwards25519.wgsl (utilisé dans les tests layer1)

### Gate de sortie

```bash
pnpm test:layer1   # scalar-mult: 0 mismatch
pnpm test:layer2   # 10k noble: 0 mismatch
```

Vérifier manuellement le gain : gen/s devrait passer de ~80k à ~180-200k.

### Arrêt — commit/push

```bash
git add -A
git commit -m "perf: fixed-base scalar-mult with precomputed 2^i*G table"
git push
```

**Prompt session suivante :**
```
Lis /Users/trixky/Projects/webgpu-ed25519/PLAN_OPTIM.md et implémente le Step 3.
Les Steps 1 et 2 (fused pipeline + fixed-base scalar_mult) sont terminés et commités.
```

---

## Step 3 — GPU prefix/suffix matching (ne readback que les hits)

**Problème actuel :** après chaque batch, on readback 2MB (65536 pubkeys × 32 bytes) puis CPU encode toutes les pubkeys en base58 (coûteux) juste pour filtrer. Pour un prefixe 3 chars : 1 hit en moyenne pour 195k tries → 99.97% des batches ont 0 hits mais paient quand même le readback.

**Solution :** filtrer sur GPU. Ne lire sur CPU que les hits + un compteur.

### Technique : bounds CPU

**Pour un prefixe de k chars :**
- `L = base58_decode(prefix + "1".repeat(44-k))` — plus petit entier 32 bytes ayant ce prefixe
- `H = base58_decode(prefix + "z".repeat(44-k))` — plus grand entier 32 bytes ayant ce prefixe
- GPU check : `L ≤ pubkey ≤ H` via `bigint_gte` (déjà dans edwards25519.wgsl)

**Pour un suffixe de k chars (k ≤ 5) :**
- `suffix_mod = 58^k` (u32, max 58^5 = 656M)
- `suffix_val = numeric_value_of_suffix` (les k derniers "digits" base58)
- GPU check : `bigint_mod_u32(pubkey, suffix_mod) == suffix_val`
- `bigint_mod_u32` : loop sur les 20 limbs MSB→LSB, `rem = (rem << LIMB_BITS | limb[i]) % m` — overflow-safe pour m ≤ 58^3 ≈ 195k (rem < m, rem << 13 < 195k × 8192 ≈ 1.6G < 2^32 ✓). Pour k=4 (m≈11M) : rem << 13 ≈ 90G → overflow u32 → utiliser u64 simulé (vec2<u32>) ou limiter GPU suffix à k ≤ 3 (vérification exacte CPU pour k > 3).

### Pipeline `pipeline_vanity.wgsl`

Bindings :
- `@binding(0) in_seeds: array<u32>` — N×8
- `@binding(1) g_table: array<u32>` — 255×16
- `@binding(2) hit_count: atomic<u32>` — compteur atomique
- `@binding(3) hit_seeds: array<u32>` — MAX_HITS × 8 (seeds des hits)
- `@binding(4) uniforms` — struct `{ L: array<u32,8>, H: array<u32,8>, suffix_mod: u32, suffix_val: u32, has_prefix: u32, has_suffix: u32 }`

Logique par thread :
```
1. Derive pubkey (SHA-512 + clamp + scalar_mult_fixed depuis g_table)
2. Si has_prefix : vérifier L ≤ pubkey ≤ H
3. Si has_suffix : vérifier pubkey mod suffix_mod == suffix_val
4. Si match : hit_idx = atomicAdd(&hit_count, 1); écrire seed dans hit_seeds[hit_idx*8]
```

CPU après dispatch :
- Readback `hit_count` (4 bytes)
- Si > 0 : readback `hit_seeds[0..hit_count*8]`
- Pour chaque hit seed : recalculer pubkey via noble (vérification exacte)

**Fallback :** si prefix ET suffix vides → utiliser pipeline derive classique (readback all pubkeys), comportement identique à aujourd'hui.

### Fichiers à créer/modifier

1. **NEW** `src/vanity/bounds.ts` — `computePrefixBounds(prefix): { L: Uint8Array, H: Uint8Array }` + `computeSuffixMod(suffix): { mod: number, val: number }`
2. **NEW** `src/shaders/pipeline_vanity.wgsl` — derive + match + atomic hit
3. **MODIFY** `src/core/pipelines.ts` — compiler pipeline `vanity`
4. **MODIFY** `src/vanity/finder.ts` — utiliser `pipeline_vanity` quand prefix/suffix non vides
5. **MODIFY** `src/index.ts` — exposer le nouveau pipeline dans `Ed25519GPU`

### Gate de sortie

```bash
pnpm test:layer3   # prefix, suffix, abort — tous verts
```

### Arrêt — commit/push

```bash
git add -A
git commit -m "perf: GPU-side prefix/suffix matching, atomic hit buffer"
git push
```

**Prompt session suivante :**
```
Lis /Users/trixky/Projects/webgpu-ed25519/PLAN_OPTIM.md et implémente le Step 4.
Les Steps 1, 2, 3 sont terminés et commités.
```

---

## Step 4 — Publish v0.2.0 + switch vanity_keypair_generator

1. Dans `webgpu-ed25519/package.json` : bump version `"0.1.0"` → `"0.2.0"`
2. `pnpm build`
3. `pnpm test:layer1 && pnpm test:layer2 && pnpm test:layer3`
4. `git tag v0.2.0 && git push --tags` → CI publie sur npm
5. Dans `vanity_keypair_generator/package.json` : `"webgpu-ed25519": "file:../webgpu-ed25519"` → `"^0.2.0"`
6. `pnpm install` dans vanity
7. `pnpm check && pnpm build` dans vanity

### Arrêt — commit/push

```bash
# dans webgpu-ed25519 :
git tag v0.2.0 && git push --tags

# dans vanity_keypair_generator :
git add -A
git commit -m "chore: switch to webgpu-ed25519@0.2.0 from npm"
git push
```

**Fin du plan.**

---

## Progression

| Step | Statut | Bloqué par |
|---|---|---|
| 1 — Fused pipeline | ✅ | — |
| 2 — Fixed-base scalar_mult | ✅ | Step 1 |
| 3 — GPU prefix/suffix matching | ❌ | Step 2 |
| 4 — Publish v0.2.0 | ❌ | Step 3 |
