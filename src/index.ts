export { isWebGPUSupported, getAdapterInfo } from './support.js';

import { initDevice } from './core/device.js';
import { compilePipelines, type Pipelines } from './core/pipelines.js';
import { derivePublicKeys } from './core/derive.js';

export class Ed25519GPU {
    private device: GPUDevice;
    private pipelines: Pipelines;

    private constructor(device: GPUDevice, pipelines: Pipelines) {
        this.device   = device;
        this.pipelines = pipelines;
    }

    static async create(opts?: GPURequestAdapterOptions): Promise<Ed25519GPU> {
        const { device } = await initDevice(opts);
        const pipelines  = await compilePipelines(device);
        return new Ed25519GPU(device, pipelines);
    }

    async derivePublicKeys(seeds: Uint8Array[]): Promise<Uint8Array[]> {
        return derivePublicKeys(this.device, this.pipelines, seeds);
    }

    destroy(): void {
        this.device.destroy();
    }
}
