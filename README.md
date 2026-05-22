# webgpu-ed25519

Ed25519 key derivation and vanity address finder running entirely on the GPU via WebGPU — works in-browser, no backend, no WASM.

Supports Solana, Stellar, Algorand, TON, and any other Ed25519-based chain.

> **Browser support:** Chromium-based browsers (Chrome, Edge, Brave). Firefox and Safari < 18 do not support WebGPU.

## Install

```bash
npm install webgpu-ed25519
# or
pnpm add webgpu-ed25519
```

## Usage

### Derive public keys

```ts
import { Ed25519GPU } from 'webgpu-ed25519';

const gpu = await Ed25519GPU.create();

// Generate 10 000 keypairs on the GPU
const seeds = Array.from({ length: 10_000 }, () =>
  crypto.getRandomValues(new Uint8Array(32))
);

const publicKeys = await gpu.derivePublicKeys(seeds);
// publicKeys[i] is the 32-byte compressed Ed25519 public key for seeds[i]

gpu.destroy();
```

### Find a vanity address (Solana)

```ts
import { Ed25519GPU } from 'webgpu-ed25519';
import { findVanity } from 'webgpu-ed25519/vanity';

const gpu = await Ed25519GPU.create();
const controller = new AbortController();

for await (const hit of findVanity(gpu, {
  prefix: 'ABC',
  signal: controller.signal,
  onProgress: (n) => console.log(`Checked ${n} keys…`),
})) {
  console.log('Found:', hit.address);
  console.log('Seed (private key):', hit.seed);
  controller.abort(); // stop after first match
}

gpu.destroy();
```

### Suffix or case-insensitive search

```ts
for await (const hit of findVanity(gpu, {
  suffix: 'pump',
  caseSensitive: false,
  batchSize: 4096,
  signal: controller.signal,
})) {
  // ...
}
```

### Non-Solana chains (custom address encoder)

```ts
import { base32Encode } from './your-encoder.js'; // Stellar uses base32

for await (const hit of findVanity(gpu, {
  prefix: 'GAAAA',
  encodeAddress: base32Encode,
  signal: controller.signal,
})) {
  // ...
}
```

### Validate a prefix before searching

```ts
import { encodePrefix } from 'webgpu-ed25519/vanity';

try {
  encodePrefix('ABCdef'); // throws if any character is not valid base58
} catch (e) {
  console.error(e.message); // "Invalid base58 character: 'l'"
}
```

### Check WebGPU support

```ts
import { isWebGPUSupported, getAdapterInfo } from 'webgpu-ed25519';

if (!isWebGPUSupported()) {
  console.warn('WebGPU not available — fall back to CPU');
} else {
  const info = await getAdapterInfo();
  console.log(info?.vendor); // e.g. "apple"
}
```

### Share an existing GPUDevice

If your app already manages its own WebGPU device, pass it directly:

```ts
const device = await myApp.getGPUDevice();
const gpu = await Ed25519GPU.fromDevice(device);
```

## API

### `webgpu-ed25519` (root)

| Export | Description |
|---|---|
| `Ed25519GPU` | Main class — create, derive, destroy |
| `Ed25519GPU.create(opts?)` | Init a new WebGPU device + compile shaders |
| `Ed25519GPU.fromDevice(device)` | Attach to an existing `GPUDevice` |
| `Ed25519GPU.derivePublicKeys(seeds)` | Derive public keys from 32-byte seeds |
| `Ed25519GPU.destroy()` | Release the GPU device |
| `isWebGPUSupported()` | Synchronous environment check |
| `getAdapterInfo()` | Async adapter vendor/architecture info |

### `webgpu-ed25519/vanity`

| Export | Description |
|---|---|
| `findVanity(gpu, opts)` | `AsyncGenerator<VanityHit>` — streams matching keypairs |
| `VanityOptions` | `prefix`, `suffix`, `caseSensitive`, `batchSize`, `signal`, `onProgress`, `encodeAddress` |
| `VanityHit` | `{ seed, publicKey, address }` |
| `encodePrefix(s)` | Validate + encode a base58 prefix string |
| `encodeSuffix(s)` | Validate + encode a base58 suffix string |

### `webgpu-ed25519/primitives`

Raw WGSL shader source strings for advanced embedding:
`SHA512_WGSL`, `BIGINT_WGSL`, `FIELD25519_WGSL`, `EDWARDS25519_WGSL`.

## React example

```tsx
function useVanitySearch(prefix: string) {
  const [hit, setHit] = useState<VanityHit | null>(null);

  useEffect(() => {
    if (!prefix) return;
    const controller = new AbortController();
    (async () => {
      const gpu = await Ed25519GPU.create();
      for await (const h of findVanity(gpu, { prefix, signal: controller.signal })) {
        setHit(h);
        break;
      }
      gpu.destroy();
    })();
    return () => controller.abort();
  }, [prefix]);

  return hit;
}
```

## Svelte example

```svelte
<script lang="ts">
  import { Ed25519GPU } from 'webgpu-ed25519';
  import { findVanity, type VanityHit } from 'webgpu-ed25519/vanity';

  let hit: VanityHit | null = null;
  let controller: AbortController;

  async function search(prefix: string) {
    controller?.abort();
    controller = new AbortController();
    const gpu = await Ed25519GPU.create();
    for await (const h of findVanity(gpu, { prefix, signal: controller.signal })) {
      hit = h;
      break;
    }
    gpu.destroy();
  }
</script>
```

## License

MIT OR Apache-2.0
