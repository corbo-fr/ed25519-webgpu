# webgpu-ed25519 — Plan d'implémentation Step 2

> **Contexte final :** cette lib sera intégrée dans `/Users/trixky/Projects/vanity_keypair_generator` (SvelteKit, Cloudflare Pages) pour remplacer le worker CPU actuel par un pipeline GPU. L'intégration se fait après que toutes les phases de ce plan sont vertes.

Statuts : ❌ pas commencé · 🔄 en cours · ✅ terminé

> **Convention sessions courtes — RÈGLE ABSOLUE :**
> - **1 tâche atomique par message.** Écrire un fichier, corriger un bug, ajouter un test — pas les trois à la fois.
> - **Sous-splitter sans limite.** Si une tâche prend plus de ~20 lignes de code, la découper. Si une sous-tâche prend plus de ~10 lignes, la re-découper.
> - **Demander avant de chercher.** Si une recherche (API, spec, calcul) est nécessaire, demander à l'utilisateur avant de le faire dans le message courant.
> - **S'arrêter et confirmer.** Après chaque fichier écrit ou modifié : s'arrêter, résumer en 1 ligne ce qui a été fait, demander confirmation avant de continuer.
> - **Context clair = `/clear` possible.** L'utilisateur veut pouvoir faire `/clear` régulièrement sans perdre d'information critique — tout l'état important doit être dans ce fichier PLAN.md.
>
> **Convention commandes lourdes :** quand une étape nécessite un run browser WebGPU, benchmark GPU, ou download réseau, demander à l'utilisateur de la lancer manuellement avec `! <commande>`.
>
> **Tests :** chaque phase doit être couverte au maximum. Avant de passer à la phase suivante, tous les tests de la phase courante doivent être verts. Si les tests tournent en browser (GPU), demander à l'utilisateur de les lancer et d'en confirmer le résultat.

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
- [x] `npx playwright install chromium`

---

## Phase 2 — WGSL primitives

Règles non négociables appliquées à tous les fichiers WGSL :
- **13-bit limbs, 20 limbs** pour GF(2^255-19) : `NUM_LIMBS=20`, `LIMB_BITS=13`, `LIMB_MASK=0x1FFF`
  - Raison : produit de deux limbes < 2^26 < 2^32, accumulation 20 × 2^26 ≈ 2^30.3 < 2^32 → pure u32, pas besoin de vec2<u32>
  - Réduction : 2^260 = 2^5 × 2^255 ≡ 32 × 19 = 608 mod p (facteur petit, fold simple)
- Zéro `min()`/`max()` entier — `select()` ou `if/else` (bug Naga MSL backend)
- Zéro boucle dans les `@compute` entries (pattern no-loop, 1 thread = 1 clé)

### 2a — SHA-512 ✅

> `src/shaders/primitives/sha512.wgsl` + `src/shaders/pipeline_sha512.wgsl` — écrits, **tests pas encore lancés**

**Action requise de l'utilisateur :** `! cd /Users/trixky/Projects/webgpu-ed25519 && pnpm test:layer1`
Résultat attendu : sha512 known vectors + 1000 random seeds → 0 mismatch

### 2b — BigInt 20-limb (13 bits) ✅

> **Commit :** `feat(shaders): bigint 20-limb 13-bit primitives`

Représentation choisie : 20 limbs × 13 bits = 260 bits (couvre 2^255 avec marge).
Produit deux limbes max = (2^13-1)² < 2^26 ≤ u32 max → accumulation sans vec2.

Sous-tâches :

- [x] Décider la représentation (13-bit × 20 limbs — voir note ci-dessus)
- [x] **2b.1** `struct BigInt { limbs: array<u32, 20> }` + constantes `LIMB_BITS=13`, `LIMB_MASK=0x1FFF`
- [x] **2b.2** `bigint_zero() -> BigInt`, `bigint_one() -> BigInt`
- [x] **2b.3** `bigint_add(a, b) -> BigInt` — addition avec carry propagation (result mod 2^260)
- [x] **2b.4** `bigint_sub(a, b) -> BigInt` — soustraction avec borrow (wraps mod 2^260)
- [x] **2b.5** `bigint_gte(a, b) -> bool` — comparaison sans `min()`/`max()`, `i -= 1u` (pas `i--`)
- [x] **2b.6** `bigint_eq(a, b) -> bool`
- [x] **2b.7** `bigint_mul(a, b) -> BigIntWide` — 20×20→**40** limbs (carry out de limb 38 → limb 39 ≤ 7)
  - `struct BigIntWide { limbs: array<u32, 40> }` — p² < 2^510 = 2^3 × 2^507, 40×13=520 ≥ 510
  - Schoolbook : boucle i=0..19, j=0..19 → wide[i+j] += a[i]*b[j]
  - Carry propagation sur les 40 limbs
- [x] **2b.8** `bigint_from_bytes_le(bytes: ptr<function, array<u32, 8>>) -> BigInt` + `bigint_to_bytes_le`
  - 32 bytes (8 × u32 little-endian) → 20 limbs × 13 bits (bits > 255 silencieusement zéro)

**Résultat** : `src/shaders/primitives/bigint.wgsl` — écrit, corrigé, **tests verts**.

### 2c — Field GF(2^255-19) ✅

> **Commit :** `feat(shaders): field arithmetic mod 2^255-19`

Dépend de 2b. Réduction via identité 2^260 ≡ 608 mod p (fold les limbs 20..39 × 608 dans limbs 0..19, 2 passes).

- [x] **2c.1** `field_p() -> BigInt` : p = 2^255-19 en 20 limbs × 13 bits
  - `p[0]=0x1FED` (= 2^13-19), `p[1..18]=0x1FFF`, `p[19]=0x00FF`
- [x] **2c.2** `field_reduce_wide(a: BigIntWide) -> BigInt`
  - Fold pass 1 : limbs 20..39 → add w[k]*608 à w[k-20]; carry propagation complète (40 limbs)
  - Fold pass 2 : repasse sur les limbs 20..39 (au plus carry 1 depuis pass 1); carry sur 20 limbs
  - Soustraction conditionnelle de p si résultat ≥ p
- [x] **2c.3** `field_add(a, b: BigInt) -> BigInt`
- [x] **2c.4** `field_sub(a, b: BigInt) -> BigInt`
- [x] **2c.5** `field_mul(a, b: BigInt) -> BigInt`
- [x] **2c.6** `field_sq(a: BigInt) -> BigInt` — aliasé sur field_mul pour v0.1
- [x] **2c.7** `field_pow(base, exp: ptr<function, array<u32, 8>>) -> BigInt` — square-and-multiply LSB-first
- [x] **2c.8** `field_inv(a: BigInt) -> BigInt` — a^(p-2) via field_pow (Fermat)
- [x] **2c.9** `field_sqrt(a: BigInt) -> BigInt` — a^((p+3)/8), correction ×i si v²=-a

**Résultat** : `src/shaders/primitives/ff.wgsl` — écrit, corrigé (bug field_reduce_wide : pass 2 utilisait 2^260≡608 au lieu de 2^255≡19, résultat jusqu'à 32p non réduit), **tests verts**.

> **Bug corrigé** : `field_reduce_wide` pass 2 — l'ancienne version foldait le carry du limb 20 par 608 (2^260 ≡ 608) mais laissait le résultat jusqu'à 2^260 ≈ 32p. La soustraction conditionnelle unique ne pouvait pas réduire à [0,p). Fix : extraire les bits 255..259 du résultat 260-bit (h = limb[19]>>8 + limb[20]×32), les fold par 19 (2^255 ≡ 19 mod p), ce qui garantit résultat < 2p.

### 2d — Montgomery ❌ (skip v0.1 si perf OK)

Si `pnpm bench` montre que field_mul est trop lent, ajouter mont.wgsl. Sinon skip.

### 2e — Edwards25519 ❌

> **Commit :** `feat(shaders): edwards25519 point operations`

Dépend de 2c. Formules étendues de Hisil 2008 (unified, pas de cas spéciaux).

- [x] **2e.1** Constantes courbe en 20 limbs :
  - `CURVE_D` : constante d = -121665/121666 mod p
  - `CURVE_2D` : 2·d mod p (formules Hisil)
  - `BASE_X`, `BASE_Y` : point générateur G (x pair, vérifié sur équation courbe)
- [x] **2e.2** `struct PointExtended { X: BigInt, Y: BigInt, Z: BigInt, T: BigInt }`
- [x] **2e.3** `point_identity() -> PointExtended` — (0, 1, 1, 0)
- [x] **2e.4** `point_add(p, q: PointExtended) -> PointExtended` — formule unifiée (8 field muls)
- [x] **2e.5** `point_double(p: PointExtended) -> PointExtended` — formule dédiée (4 muls + 4 sq)
- [x] **2e.6** `point_compress(p: PointExtended) -> array<u32, 8>` — y + signe(x), little-endian
- [x] **2e.7** `scalar_mult(scalar: ptr<function, array<u32, 8>>, base: PointExtended) -> PointExtended`
  - Double-and-add 255 itérations, itératif, pas de récursion

### 2f — Pipelines compute ❌

> **Commit :** `feat(shaders): compute pipeline entries sha512 + scalar_mult`

- [ ] `src/shaders/pipeline_sha512.wgsl` ✅ (écrit, pas testé)
  - [ ] Ajouter clamping in-place du digest dans le shader
- [ ] `src/shaders/pipeline_scalar_mult.wgsl`
  - [ ] Bindings : seeds clampés (N×32 bytes) → pubkeys (N×32 bytes)
  - [ ] `@compute @workgroup_size(64)` — 1 thread = 1 clé
  - [ ] Lecture scalaire[gid.x] → bigint_from_bytes_le → scalar_mult(G) → point_compress → écriture

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

- [x] `test/gpu/primitives/field25519.test.ts` — **tous verts**
  - [x] `field_add` : 1000 paires aléatoires vs noble `Fp.add` + edge cases (0, p-1)
  - [x] `field_sub` : 1000 paires vs noble `Fp.sub` + edge cases
  - [x] `field_mul` : 1000 paires vs noble `Fp.mul` + edge cases
  - [x] `field_sq` : 1000 valeurs vs noble `Fp.sqr`
  - [x] `field_inv` : 500 valeurs vs `a*inv(a)==1` + inv(0)=0

> **Commit :** `test(layer1): edwards25519 point operations`

- [x] `test/gpu/primitives/edwards25519.test.ts` — **tous verts**
  - [x] `point_add` : 1000 paires de points aléatoires vs noble
  - [x] `point_double` : 1000 points vs noble
  - [x] `point_add(identity, P) = P` et `point_add(P, identity) = P`
  - [x] `point_compress` : 100 points vs noble output
  - Bug corrigé : `point_add` utilisait `curve_2d()` au lieu de `curve_d()` pour C=T1·T2·d (noble uses d, not 2d)

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

| Phase | Statut | Bloqué par |
|---|---|---|
| 1 — Bootstrap config | ✅ | — |
| 2a — SHA-512 WGSL | ✅ | — |
| 2b — BigInt 20-limb 13-bit | ✅ | — |
| 2c — Field GF(2^255-19) | ✅ | — |
| 2d — Montgomery | ❌ skip v0.1 | bench |
| 2e — Edwards25519 | ✅ | — |
| 2f — Pipelines compute | ❌ | 2e vert |
| 3 — Test layer 1 (sha512+field) | ✅ | — |
| 3 — Test layer 1 (edwards) | ✅ | — |
| 3 — Test layer 1 (scalar-mult) | ❌ | edwards vert |
| 4 — TypeScript core | ❌ | layer1 vert |
| 5 — Test layer 2 | ❌ | toi : `pnpm test:layer2` |
| 6 — Vanity helper | ❌ | layer2 vert |
| 7 — Test layer 3 | ❌ | toi : `pnpm test:layer3` |
| 8 — CI | ❌ | layer3 vert |
