# webgpu-ed25519 — Plan d'implémentation Step 2

Statuts : ❌ pas commencé · 🔄 en cours · ✅ terminé

---

## Phase 1 — Bootstrap config ✅

> **Commit :** `chore: bootstrap config, licenses, toolchain`

- [x] `tsconfig.json` — ESNext, moduleResolution bundler, strict, no emit
- [x] `tsconfig.build.json` — extends tsconfig.json, emit vers `dist/`, exclude test/
- [x] `vitest.config.ts` — projet `node` (env node) + projet `browser` (playwright chromium `--enable-unsafe-webgpu --enable-features=Vulkan`)
- [x] `LICENSE` — MIT
- [x] `LICENSE-APACHE` — Apache-2.0
- [x] `.gitignore` — node_modules, dist, .wrangler
- [x] `pnpm install` — vérifier que `vitest`, `@vitest/browser`, `playwright`, `@noble/curves`, `@noble/hashes`, `typescript` sont installés
- [ ] `npx playwright install chromium` *(réseau indisponible — à lancer manuellement)*

---

## Phase 2 — WGSL primitives ❌

Règles non négociables appliquées à tous les fichiers WGSL :
- `vec2<u32>` pour le 64-bit (x=high, y=low)
- 10 limbs × 26 bits pour GF(2^255-19) : `num_limbs=10`, `log_limb_size=26`, `mask=0x3FFFFFF`
- Zéro `min()`/`max()` entier — `select()` ou `if/else` (bug Naga MSL backend)
- Zéro boucle dans les `@compute` entries (pattern no-loop, 1 thread = 1 clé)

### 2a — SHA-512 ❌

> **Commit :** `feat(shaders): sha512 vec2<u32> for 32-byte input`

- [ ] `src/shaders/primitives/sha512.wgsl`
  - [ ] Types/helpers : `vec2<u32>` pour u64, `rotr64(v, bits)` (cas bits<32 et bits≥32)
  - [ ] `add64(a, b)` avec carry detection via u32 overflow
  - [ ] `shr64(a, n)` et `shl64(a, n)`
  - [ ] 80 round constants `array<vec2<u32>, 80>` (SHA-512 standard)
  - [ ] Hash initial state `array<vec2<u32>, 8>`
  - [ ] Fonctions `ch64`, `maj64`, `sigma0_64`, `sigma1_64`, `gamma0_64`, `gamma1_64`
  - [ ] Fonction `sha512_32(seed: array<u32, 8>) -> array<vec2<u32>, 8>` :
    - [ ] Padding fixe pour 32-byte input (1 bloc de 128 bytes : W[8]=0x80000000, W[14]=0, W[15]=0x100)
    - [ ] Message schedule W (16 mots initiaux + expansion jusqu'à 80)
    - [ ] 80 rounds de compression
    - [ ] Addition état final

### 2b — BigInt 10-limb ❌

> **Commit :** `feat(shaders): bigint 10-limb u26 primitives`

- [ ] `src/shaders/primitives/bigint.wgsl`
  - [ ] `struct BigInt { limbs: array<u32, 10> }` et `struct BigIntWide { limbs: array<u32, 20> }`
  - [ ] `bigint_zero()`, `bigint_one()`
  - [ ] `bigint_add(a, b) -> BigInt` avec carry propagation
  - [ ] `bigint_sub(a, b) -> BigInt` avec borrow propagation
  - [ ] `bigint_mul(a, b) -> BigIntWide` — multiplication large 10×10→20 limbs
  - [ ] `bigint_gte(a, b) -> bool` — comparaison (sans `min`/`max`)
  - [ ] `bigint_eq(a, b) -> bool`
  - [ ] `bigint_from_bytes_le(bytes: array<u32, 8>) -> BigInt` — 32 bytes LE → 10 limbs

### 2c — Field GF(2^255-19) ❌

> **Commit :** `feat(shaders): field arithmetic mod 2^255-19`

- [ ] `src/shaders/primitives/ff.wgsl`
  - [ ] Constante `FIELD_P` : 2^255-19 en 10 limbs
  - [ ] `field_reduce(a: BigIntWide) -> BigInt` — réduction mod p après multiplication
  - [ ] `field_add(a, b) -> BigInt` — addition mod p
  - [ ] `field_sub(a, b) -> BigInt` — soustraction mod p (résultat positif)
  - [ ] `field_mul(a, b) -> BigInt` — multiplication mod p (appelle bigint_mul + field_reduce)
  - [ ] `field_sq(a) -> BigInt` — carré mod p (optimisé ou aliasé sur field_mul)
  - [ ] `field_pow(a, exp: BigInt) -> BigInt` — exponentiation (addition chain itérative, no recursion)
  - [ ] `field_inv(a) -> BigInt` — Fermat : a^(p-2) mod p via addition chain fixe (255 squarings + multiplications)
  - [ ] `field_sqrt(a) -> BigInt` — racine carrée (p ≡ 5 mod 8, formule Tonelli-Shanks simplifiée)

### 2d — Montgomery (optionnel selon perf) ❌

> **Commit :** `feat(shaders): montgomery multiplication` *(skip si field_mul assez rapide)*

- [ ] `src/shaders/primitives/mont.wgsl`
  - [ ] `struct MontBigInt { limbs: array<u32, 10> }` — représentation Montgomery
  - [ ] `mont_R`, `mont_R2`, `mont_N_prime` pour p = 2^255-19
  - [ ] `mont_mul(a, b) -> MontBigInt` — CIOS algorithm
  - [ ] `to_mont(a) -> MontBigInt`, `from_mont(a) -> BigInt`
  - [ ] **Note :** si les tests layer 1 montrent que field_mul (non-Montgomery) est suffisamment rapide sur GPU, cette phase peut être ignorée en v0.1.0

### 2e — Edwards25519 ❌

> **Commit :** `feat(shaders): edwards25519 point operations`

- [ ] `src/shaders/primitives/edwards25519.wgsl`
  - [ ] Constantes de courbe : `D` (constante de torsion Ed25519), `GX`, `GY` (point générateur)
  - [ ] `struct PointExtended { X: BigInt, Y: BigInt, Z: BigInt, T: BigInt }` — coordonnées projectives étendues
  - [ ] `point_identity() -> PointExtended`
  - [ ] `point_add(p, q) -> PointExtended` — addition complète (formule unifiée Hisil 2008)
  - [ ] `point_double(p) -> PointExtended`
  - [ ] `point_compress(p) -> array<u32, 8>` — compress vers 32 bytes (coordonnée y + bit de signe de x)
  - [ ] `scalar_mult(scalar: array<u32, 8>, base: PointExtended) -> PointExtended` — double-and-add 255 bits, itératif, no recursion

### 2f — Pipelines compute ❌

> **Commit :** `feat(shaders): compute pipeline entries sha512 + scalar_mult`

- [ ] `src/shaders/pipeline_sha512.wgsl`
  - [ ] Bindings : `@binding(0)` seeds (N×32 bytes en/), `@binding(1)` digests (N×64 bytes sortie)
  - [ ] `@compute @workgroup_size(64)` — `fn main(@builtin(global_invocation_id) gid: vec3<u32>)`
  - [ ] Lecture seed[gid.x], appel sha512_32, écriture digest[gid.x]
  - [ ] Clamping in-place du digest (bits 0, 1, 2, 255 du scalaire résultant)
- [ ] `src/shaders/pipeline_scalar_mult.wgsl`
  - [ ] Bindings : `@binding(0)` scalaires (N×32 bytes), `@binding(1)` pubkeys (N×32 bytes sortie)
  - [ ] `@compute @workgroup_size(64)`
  - [ ] Lecture scalaire[gid.x], scalar_mult vs G, point_compress, écriture pubkey[gid.x]

---

## Phase 3 — Test layer 1 : primitives isolées ❌

Harness commun avant les tests individuels.

> **Commit :** `test(layer1): gpu test harness + sha512 vectors`

- [ ] `test/gpu/helpers/gpu.ts` — helper `setupGPU()` qui retourne `{device, queue}`
- [ ] `test/gpu/helpers/shader-runner.ts` — `runShader(device, wgsl, inputBuffers, outputSizes)` → `Uint8Array[]`
- [ ] `test/gpu/primitives/sha512.test.ts`
  - [ ] 3 vecteurs FIPS 180-4 pour SHA-512 (messages courts)
  - [ ] Seed all-zero (32 bytes) → vérifier vs `@noble/hashes sha512`
  - [ ] Seed all-FF → vérifier vs noble
  - [ ] 100 seeds aléatoires → 100% match noble
  - [ ] Vérifier le clamping : bits 0-2 du byte 0 = 0, bit 7 du byte 31 = 0, bit 6 du byte 31 = 1

> **Commit :** `test(layer1): field25519 vectors`

- [ ] `test/gpu/primitives/field25519.test.ts`
  - [ ] `field_add` : 1000 paires aléatoires vs noble `Fp.add`
  - [ ] `field_sub` : 1000 paires → résultat toujours dans [0, p)
  - [ ] `field_mul` : 1000 paires vs noble `Fp.mul`
  - [ ] `field_sq` : 1000 valeurs vs noble `Fp.sqr`
  - [ ] `field_inv` : 500 valeurs vs noble `Fp.inv`, + inv(0) = 0
  - [ ] Edge cases : 0, 1, p-1 pour chaque opération

> **Commit :** `test(layer1): edwards25519 point operations`

- [ ] `test/gpu/primitives/edwards25519.test.ts`
  - [ ] `point_add` : 1000 paires de points aléatoires vs noble
  - [ ] `point_double` : 1000 points vs noble
  - [ ] `point_add(identity, P) = P` et `point_add(P, identity) = P`
  - [ ] `point_compress` : 100 points vs noble output

> **Commit :** `test(layer1): scalar multiplication`

- [ ] `test/gpu/primitives/scalar-mult.test.ts`
  - [ ] `scalar_mult(0, G) = identity`
  - [ ] `scalar_mult(1, G) = G`
  - [ ] `scalar_mult(2, G) = 2G` vs noble
  - [ ] 1000 scalaires aléatoires vs `noble.getPublicKey`
  - [ ] Scalaires edge : `l-1` (ordre de la courbe moins 1), `l` (=identity)

**Gate layer 1 :** `pnpm test:layer1` → 0 mismatch avant de continuer

---

## Phase 4 — TypeScript core ❌

> **Commit :** `feat(core): GPU device, buffers, pipelines, derive`

- [ ] `src/support.ts`
  - [ ] `isWebGPUSupported(): boolean`
  - [ ] `getAdapterInfo(): Promise<{vendor, architecture, description} | null>`
- [ ] `src/core/device.ts`
  - [ ] `initDevice(opts?) -> Promise<{adapter, device}>`
  - [ ] Handler `device.lost` — loggue et rejette les opérations en cours
- [ ] `src/core/buffers.ts`
  - [ ] `createStorageBuffer(device, size, data?)` — STORAGE | COPY_DST
  - [ ] `createReadbackBuffer(device, size)` — MAP_READ | COPY_SRC
  - [ ] `uploadBuffer(device, buf, data: Uint8Array)`
  - [ ] `readbackBuffer(device, buf, size) -> Promise<Uint8Array>`
- [ ] `src/core/pipelines.ts`
  - [ ] `compilePipelines(device) -> Promise<{sha512Pipeline, scalarMultPipeline}>`
  - [ ] Utilise `createComputePipelineAsync` pour les deux
  - [ ] Cache : si déjà compilé pour ce device, retourne le cache
- [ ] `src/core/derive.ts`
  - [ ] `derivePublicKeys(device, pipelines, seeds: Uint8Array[]) -> Promise<Uint8Array[]>`
  - [ ] Split en batches de 64k si nécessaire
  - [ ] Pass 1 : pipeline_sha512 (seeds → digests clampés)
  - [ ] Pass 2 : pipeline_scalar_mult (scalaires → pubkeys)
- [ ] `src/index.ts`
  - [ ] `export class Ed25519GPU { static create(opts?) ; derivePublicKeys(seeds) ; destroy() }`

---

## Phase 5 — Test layer 2 : dérivation end-to-end ❌

> **Commit :** `test(layer2): RFC 8032 vectors + noble equivalence`

- [ ] `test/gpu/derive/rfc8032.test.ts`
  - [ ] 4 vecteurs officiels RFC 8032 §6.1 (seed → pubkey) — bytes exacts
- [ ] `test/gpu/derive/noble-equivalence.test.ts`
  - [ ] 1 000 seeds aléatoires → 100% match `@noble/ed25519 getPublicKey`
  - [ ] 10 000 seeds aléatoires → 100% match (CI)
- [ ] `test/gpu/derive/edge-seeds.test.ts`
  - [ ] all-zero (32 bytes), all-0xFF, all-0x01, alternance 0xAA/0x55 → match noble

**Gate layer 2 :** `pnpm test:layer2` → 0 mismatch avant de continuer

---

## Phase 6 — Vanity helper ❌

> **Commit :** `feat(vanity): matcher, finder, primitives export`

- [ ] `src/vanity/matcher.ts`
  - [ ] `encodePrefix(prefix: string): Uint8Array` — encode en bytes base58 comparables
  - [ ] `encodeSuffix(suffix: string): Uint8Array`
  - [ ] `matches(pubkey58: string, prefix, suffix, caseSensitive): boolean`
- [ ] `src/vanity/finder.ts`
  - [ ] `findVanity(gpu, opts): AsyncIterable<VanityHit>`
  - [ ] Boucle rAF (ou `setImmediate` en Worker context)
  - [ ] Respect `opts.signal` (AbortSignal) → nettoyage buffers GPU
  - [ ] Appel `opts.onProgress` toutes les N itérations
  - [ ] `opts.encodeAddress` par défaut = base58 Solana
- [ ] `src/vanity/index.ts` — export `findVanity`, `VanityHit`, `VanityOptions`
- [ ] `src/primitives/index.ts` — export strings WGSL brutes (SHA512_WGSL, FIELD25519_WGSL, etc.)

---

## Phase 7 — Test layer 3 : vanity helper ❌

> **Commit :** `test(layer3): vanity prefix, suffix, abort`

- [ ] `test/gpu/vanity/prefix.test.ts`
  - [ ] Préfixe "a" → hit trouvé en < 3s
  - [ ] Vérifier le hit : recalculer pubkey depuis seed via noble, comparer
  - [ ] Préfixe "11" (moins commun)
- [ ] `test/gpu/vanity/suffix.test.ts`
  - [ ] Suffixe "z" → hit trouvé en < 3s, vérifié
- [ ] `test/gpu/vanity/abort.test.ts`
  - [ ] AbortSignal déclenché à 200ms → `findVanity` se termine proprement (pas de throw non catchée)
  - [ ] Après abort : aucun GPUBuffer actif (via `device.createBuffer` spy ou compteur manuel)

**Gate layer 3 :** `pnpm test:layer3` → tous verts avant de continuer

---

## Phase 8 — CI ❌

> **Commit :** `ci: github actions chromium webgpu + publish workflow`

- [ ] `.github/workflows/test.yml`
  - [ ] Ubuntu latest + Chrome stable
  - [ ] Flags : `--enable-unsafe-webgpu --enable-features=Vulkan`
  - [ ] Jobs : `pnpm test:node`, `pnpm test:layer1`, `pnpm test:layer2`, `pnpm test:layer3`
- [ ] `.github/workflows/publish.yml`
  - [ ] Trigger : push tag `v*`
  - [ ] `pnpm build` + `npm publish --access public`

---

## Gate finale Step 2 → Step 3

```bash
pnpm test:layer1   # sha512, field25519, edwards25519, scalar-mult — 0 mismatch
pnpm test:layer2   # RFC 8032 exact bytes + 10k noble equivalence — 0 mismatch
pnpm test:layer3   # prefix, suffix, abort, no-leak — tous verts
```

Test manuel sur Metal (machine courante, M-series) :
- [ ] Mêmes seeds que layer2 → 0 mismatch vs noble sur Metal
- [ ] `findVanity` préfixe "sol" → hit trouvé, vérifié par noble

**Si un seul mismatch subsiste : ne pas passer au Step 3.** Une lib GPU silencieusement fausse génère des keypairs invalides.

---

## Progression

| Phase | Statut |
|---|---|
| 1 — Bootstrap config | ✅ |
| 2a — SHA-512 WGSL | ❌ |
| 2b — BigInt WGSL | ❌ |
| 2c — Field GF(2^255-19) WGSL | ❌ |
| 2d — Montgomery WGSL | ❌ |
| 2e — Edwards25519 WGSL | ❌ |
| 2f — Pipelines compute WGSL | ❌ |
| 3 — Test layer 1 | ❌ |
| 4 — TypeScript core | ❌ |
| 5 — Test layer 2 | ❌ |
| 6 — Vanity helper | ❌ |
| 7 — Test layer 3 | ❌ |
| 8 — CI | ❌ |
