export { isWebGPUSupported, getAdapterInfo } from './support.js';

import { initDevice } from './core/device.js';
import { compilePipelines, type Pipelines } from './core/pipelines.js';
import { computeGTable, createGTableBuffer } from './core/table.js';
import { createDeriveBufs, destroyDeriveBufs, runDeriveBatch, type DeriveBufs } from './core/derive.js';
import { runVanityBatch, createVanityBufs, destroyVanityBufs, type VanityBufs, type VanityBatchOpts } from './core/vanity.js';

const DERIVE_BATCH = 65536;

const CALIB_SIZES = [4096, 16384, 65536, 131072, 262144];
const CALIB_NO_FILTER: VanityBatchOpts = {
    L: new Uint32Array(8),
    H: new Uint32Array(8).fill(0xFFFFFFFF),
    hasPrefix: false,
    suffixMod: 0,
    suffixVal: 0,
    hasSuffix: false,
};

/** High-level GPU-accelerated Ed25519 key derivation. */
export class Ed25519GPU {
    private device: GPUDevice;
    private pipelines: Pipelines;
    private gTableBuf: GPUBuffer;
    private vanityBufs: VanityBufs | null = null;
    private vanityBufN = 0;
    private deriveBufs: DeriveBufs | null = null;
    private deriveBufN = 0;
    private _calibratedBatchSize?: number;

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
     * Probe the GPU across batch sizes [4096, 16384, 65536, 131072, 262144] and
     * return the smallest size that achieves ≥95% of peak throughput. The result
     * is cached on this instance, so subsequent calls are instant.
     *
     * Use this to feed `batchSize` in `findVanity`, or pass `batchSize: 'auto'`
     * to have `findVanity` call it automatically before the first batch.
     */
    async calibrateBatchSize(): Promise<number> {
        if (this._calibratedBatchSize !== undefined) return this._calibratedBatchSize;

        const RUNS = 3;
        const CHUNK = 65536;
        const throughputs: number[] = [];

        for (const N of CALIB_SIZES) {
            const seeds = new Uint8Array(N * 32);
            for (let off = 0; off < seeds.byteLength; off += CHUNK)
                crypto.getRandomValues(seeds.subarray(off, Math.min(off + CHUNK, seeds.byteLength)));

            await this._vanityBatch(seeds, CALIB_NO_FILTER);

            let totalMs = 0;
            for (let r = 0; r < RUNS; r++) {
                for (let off = 0; off < seeds.byteLength; off += CHUNK)
                    crypto.getRandomValues(seeds.subarray(off, Math.min(off + CHUNK, seeds.byteLength)));
                const t0 = performance.now();
                await this._vanityBatch(seeds, CALIB_NO_FILTER);
                totalMs += performance.now() - t0;
            }

            throughputs.push((N * RUNS / totalMs) * 1000);
        }

        const maxThroughput = Math.max(...throughputs);
        const threshold = maxThroughput * 0.95;
        let bestIdx = throughputs.length - 1;
        for (let i = 0; i < throughputs.length; i++) {
            if (throughputs[i] >= threshold) { bestIdx = i; break; }
        }

        this._calibratedBatchSize = CALIB_SIZES[bestIdx];
        return this._calibratedBatchSize;
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
