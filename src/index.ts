export { isWebGPUSupported, getAdapterInfo } from './support.js';

import { initDevice } from './core/device.js';
import { compilePipelines, type Pipelines } from './core/pipelines.js';
import { computeGTable, createGTableBuffer } from './core/table.js';
import { derivePublicKeys } from './core/derive.js';

/** High-level GPU-accelerated Ed25519 key derivation. */
export class Ed25519GPU {
    private device: GPUDevice;
    private pipelines: Pipelines;
    private gTableBuf: GPUBuffer;

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
        return derivePublicKeys(this.device, this.pipelines, this.gTableBuf, seeds);
    }

    /** Release the underlying GPUDevice. Call when done to free GPU resources. */
    destroy(): void {
        this.gTableBuf.destroy();
        this.device.destroy();
    }
}
