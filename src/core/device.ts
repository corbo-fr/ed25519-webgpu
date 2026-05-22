export type DeviceHandle = { adapter: GPUAdapter; device: GPUDevice };

export async function initDevice(opts?: GPURequestAdapterOptions): Promise<DeviceHandle> {
    if (!navigator.gpu) throw new Error('WebGPU not supported');
    const adapter = await navigator.gpu.requestAdapter(opts);
    if (!adapter) throw new Error('No WebGPU adapter found');
    const device = await adapter.requestDevice();
    device.lost.then((info) => {
        console.error(`WebGPU device lost: ${info.reason} — ${info.message}`);
    });
    return { adapter, device };
}

