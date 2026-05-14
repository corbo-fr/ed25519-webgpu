# webgpu-ed25519 — Plan Step 3 : intégration dans vanity_keypair_generator

> **Contexte :** `webgpu-ed25519` (Step 2 ✅) est prête. Ce plan intègre la lib dans
> `/Users/trixky/Projects/vanity_keypair_generator` (SvelteKit, Cloudflare Pages).
> Worker CPU actuel : Rust WASM-SIMD (`vanity-worker.ts`). Cible : GPU si dispo, fallback CPU.

Statuts : ❌ pas commencé · 🔄 en cours · ✅ terminé

> **Convention sessions courtes — RÈGLE ABSOLUE :**
> - **1 tâche atomique par message.**
> - **S'arrêter et confirmer** après chaque fichier écrit ou modifié.
> - **Tout l'état critique est ici.** L'utilisateur peut faire `/clear` à tout moment.

---

## Comment itérer vite entre le package et vanity

**En développement** — ne pas publier sur npm à chaque changement :

```bash
# 1. Dans vanity_keypair_generator/package.json → ajouter :
#    "webgpu-ed25519": "file:../webgpu-ed25519"
# 2. pnpm install → crée un lien symlink dans node_modules
# 3. Dans webgpu-ed25519 :
pnpm build --watch   # tsc -p tsconfig.build.json --watch
# 4. Dans vanity_keypair_generator :
pnpm dev             # Vite détecte les changements dans le symlink et HMR
```

Résultat : modifier un fichier dans `webgpu-ed25519/src/` → tsc rebuild → Vite HMR → page rechargée.
Pas de publish, pas de version bump, pas de cache npm.

**Pour publier** (quand c'est stable) :
1. Bump version dans `webgpu-ed25519/package.json`
2. `git tag v0.1.1 && git push --tags` → workflow `publish.yml` publie sur npm
3. Dans vanity : remplacer `"file:../webgpu-ed25519"` par `"^0.1.1"` + `pnpm install`

---

## Est-ce qu'on est sûrs que ça marche ?

Oui, avec les garanties suivantes (tout commité) :
- **Cryptographie** : 1000 scalaires random vs noble, RFC 8032 exact bytes, edge seeds → 0 mismatch
- **Vanity** : prefix/suffix/abort testés en browser Chromium (Playwright)
- **Metal** : layer2 + findVanity "GPU" vérifiés manuellement sur M-series (757ms, noble-confirmé)
- **Limites connues** :
  - WebGPU Chromium uniquement (pas Firefox stable, pas Safari <18)
  - Cloudflare Pages ne limite pas WebGPU côté browser (API browser, pas serveur)
  - Pas de Montgomery → perf plafonnée, acceptable pour v0.1

---

## Phase 1 — Dev link ❌

> **Projet :** `vanity_keypair_generator`
> **Commit :** `chore: link webgpu-ed25519 local, add build:watch`

- [ ] **1.1** Dans `vanity_keypair_generator/package.json` → ajouter dans `dependencies` :
  ```json
  "webgpu-ed25519": "file:../webgpu-ed25519"
  ```
- [ ] **1.2** `pnpm install` dans vanity → vérifier symlink `node_modules/webgpu-ed25519`
- [ ] **1.3** Dans `webgpu-ed25519/package.json` → ajouter script :
  ```json
  "build:watch": "tsc -p tsconfig.build.json --watch"
  ```
- [ ] **1.4** Vérifier que `import { isWebGPUSupported } from 'webgpu-ed25519'` compile sans erreur dans vanity

---

## Phase 2 — GPU worker ❌

> **Projet :** `vanity_keypair_generator`
> **Commit :** `feat(gpu): vanity-gpu-worker — même protocole que vanity-worker`

Le worker GPU doit émettre **exactement le même format de messages** que `vanity-worker.ts`
pour que `keypair-state.svelte.ts` n'ait pas à changer.

Format secretKey actuel (WASM) : 64 bytes = `seed(32) || pubkey(32)`, puis base58.
Notre GPU retourne `hit.seed` (32 bytes) + `hit.publicKey` (32 bytes) → concat → base58.

- [ ] **2.1** Créer `src/routes/vanity-gpu-worker.ts`
  - `Ed25519GPU.create()` au démarrage
  - `onmessage` : `start` → lance `findVanity()`, `stop` → `controller.abort()`
  - `found` : `{ type: 'found', result: { address, privateKey: base58(seed||pubkey) }, tries }`
  - `progress` : `{ type: 'progress', tries, bestScore: 0, bestAddress: '', bestPrivateKey: '' }`
    - Note : `findVanity` ne remonte pas de "meilleur partiel" → bestScore=0 acceptable
  - `stopped` : `{ type: 'stopped', tries }`
  - Si WebGPU indispo : `postMessage({ type: 'error', message: 'WebGPU not available' })`

---

## Phase 3 — Feature detect + dispatch ❌

> **Projet :** `vanity_keypair_generator`
> **Commit :** `feat(gpu): feature-detect WebGPU, dispatch GPU/CPU worker`

- [ ] **3.1** Dans `keypair-state.svelte.ts` → ajouter `backend: 'gpu' | 'cpu'` dans `s`
- [ ] **3.2** Fonction `detectBackend(): Promise<'gpu' | 'cpu'>` :
  ```ts
  import { isWebGPUSupported } from 'webgpu-ed25519';
  // + tenter navigator.gpu.requestAdapter() → null = pas de GPU réel
  ```
- [ ] **3.3** Dans `generate()` :
  - Si `backend === 'gpu'` → 1 seul worker `vanity-gpu-worker.ts` (le GPU parallélise déjà)
  - Si `backend === 'cpu'` → N workers `vanity-worker.ts` (comportement actuel)
  - `s.workerTries` reste un tableau (longueur 1 en GPU, N en CPU)
- [ ] **3.4** Le slider `threads` reste visible mais grisé si GPU actif

---

## Phase 4 — UI ❌

> **Projet :** `vanity_keypair_generator`
> **Commit :** `feat(ui): GPU badge, backend indicator`

- [ ] **4.1** Badge "GPU" / "CPU" à côté du compteur de perf (`+page.svelte` ou `ProgressCell.svelte`)
- [ ] **4.2** Si GPU : masquer ou griser le slider threads (montrer "1 GPU worker" à la place)
- [ ] **4.3** (optionnel) Afficher `getAdapterInfo()` vendor dans un tooltip sur le badge GPU

---

## Phase 5 — Build + smoke test ❌

> **Commit :** `chore: verify Cloudflare build with GPU backend`

- [ ] **5.1** `pnpm build` dans vanity → 0 erreur TS, bundle Cloudflare propre
- [ ] **5.2** `pnpm preview` (`wrangler dev`) → ouvrir browser, lancer vanity GPU, vérifier hit
- [ ] **5.3** Vérifier fallback : désactiver WebGPU dans DevTools → backend=cpu, worker WASM actif

---

## Gate finale Step 3

```bash
# Dans vanity_keypair_generator :
pnpm check    # 0 erreur TS
pnpm build    # bundle Cloudflare propre
pnpm preview  # smoke test browser GPU + fallback CPU
```

Critères de validation :
- [ ] GPU backend : trouve un hit, clé téléchargeable, noble-vérifiable offline
- [ ] CPU fallback : marche normalement si WebGPU absent
- [ ] Pas de régression sur le flow non-vanity (génération de keypair simple)

---

## Progression

| Phase | Statut | Bloqué par |
|---|---|---|
| 1 — Dev link local | ❌ | — |
| 2 — GPU worker | ❌ | Phase 1 |
| 3 — Feature detect + dispatch | ❌ | Phase 2 |
| 4 — UI badge | ❌ | Phase 3 |
| 5 — Build + smoke test | ❌ | Phase 4 |
