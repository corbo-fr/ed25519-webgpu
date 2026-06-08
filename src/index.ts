export { isWebGPUSupported, getAdapterInfo } from './support.js';

import { initDevice } from './core/device.js';
import { compilePipelines, type Pipelines } from './core/pipelines.js';
import { computeGTable, createGTableBuffer } from './core/table.js';
import { createDeriveBufs, destroyDeriveBufs, runDeriveBatch, type DeriveBufs } from './core/derive.js';
import { runVanityBatch, createVanityBufs, destroyVanityBufs, type VanityBufs, type VanityBatchOpts } from './core/vanity.js';

const DERIVE_BATCH = 65536;

/** High-level GPU-accelerated Ed25519 key derivation. */
export class Ed25519GPU {
    private device: GPUDevice;
    private pipelines: Pipelines;
    private gTableBuf: GPUBuffer;
    private vanityBufs: VanityBufs | null = null;
    private vanityBufN = 0;
    private deriveBufs: DeriveBufs | null = null;
    private deriveBufN = 0;

    private constructor(device: GPUDevice, pipelines: Pipelines, gTableBuf: GPUBuffer) {
        this.device    = device;
        this.pipelines = pipelines;
        this.gTableBuf = gTableBuf;
    }

    /**
     * Create an Ed25519GPU instance, initialising a new WebGPU device.
     * Throws if WebGPU is not supported or no adapter is found.
     */
    static async create(opts?: GPURequestAdapterOptions): Promise<Ed25519GPU> {
        const { device } = await initDevice(opts);
        const [pipelines, tableData] = await Promise.all([
            compilePipelines(device),
            Promise.resolve(computeGTable()),
        ]);
        const gTableBuf = createGTableBuffer(device, tableData);
        return new Ed25519GPU(device, pipelines, gTableBuf);
    }

    /**
     * Attach Ed25519GPU to an existing GPUDevice.
     * Use this when your app already manages its own WebGPU device.
     */
    static async fromDevice(device: GPUDevice): Promise<Ed25519GPU> {
        const [pipelines, tableData] = await Promise.all([
            compilePipelines(device),
            Promise.resolve(computeGTable()),
        ]);
        const gTableBuf = createGTableBuffer(device, tableData);
        return new Ed25519GPU(device, pipelines, gTableBuf);
    }

    /**
     * Derive Ed25519 public keys from an array of 32-byte seeds.
     * Each seed follows the standard Ed25519 private key format (RFC 8032):
     * it is SHA-512 hashed and clamped on the GPU before scalar multiplication.
     */
    async derivePublicKeys(seeds: Uint8Array[]): Promise<Uint8Array[]> {
        const results: Uint8Array[] = [];
        for (let off = 0; off < seeds.length; off += DERIVE_BATCH) {
            const chunk = seeds.slice(off, off + DERIVE_BATCH);
            const N = chunk.length;
            if (!this.deriveBufs || this.deriveBufN !== N) {
                if (this.deriveBufs) destroyDeriveBufs(this.deriveBufs);
                this.deriveBufs = createDeriveBufs(this.device, this.pipelines, this.gTableBuf, N);
                this.deriveBufN = N;
            }
            results.push(...await runDeriveBatch(this.device, this.pipelines, this.deriveBufs, chunk));
        }
        return results;
    }

    /**
     * Run a single GPU vanity batch. Returns raw seeds of keys that passed the
     * GPU prefix/suffix filter; callers must CPU-verify the results.
     * @internal used by findVanity
     */
    _vanityBatch(seedsFlat: Uint8Array, opts: VanityBatchOpts): Promise<Uint8Array[]> {
        const N = seedsFlat.byteLength / 32;
        if (!this.vanityBufs || this.vanityBufN !== N) {
            if (this.vanityBufs) destroyVanityBufs(this.vanityBufs);
            this.vanityBufs = createVanityBufs(this.device, this.pipelines, this.gTableBuf, N);
            this.vanityBufN = N;
        }
        return runVanityBatch(this.device, this.pipelines, this.vanityBufs, seedsFlat, opts);
    }

    /** Release the underlying GPUDevice. Call when done to free GPU resources. */
    destroy(): void {
        if (this.vanityBufs) destroyVanityBufs(this.vanityBufs);
        if (this.deriveBufs) destroyDeriveBufs(this.deriveBufs);
        this.gTableBuf.destroy();
        this.device.destroy();
    }
}
