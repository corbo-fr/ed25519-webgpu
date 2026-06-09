export type DeviceHandle = { adapter: GPUAdapter; device: GPUDevice };

export async function initDevice(opts?: GPURequestAdapterOptions): Promise<DeviceHandle> {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
        throw new Error('webgpu-ed25519 requires a browser environment with WebGPU support');
    }
    // powerPreference defaults to high-performance to select the discrete GPU when available.
    // Callers can override by passing opts.powerPreference explicitly.
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance', ...opts });
    if (!adapter) throw new Error('No WebGPU adapter found');
    const device = await adapter.requestDevice();
    device.lost.then((info) => {
        console.error(`[webgpu-ed25519] device lost (${info.reason}): ${info.message}`);
    });
    // Surface GPU validation errors (e.g. out-of-bounds buffer access, invalid pipeline state).
    // These are swallowed silently by default, making wgpu/Firefox crashes hard to diagnose.
    device.addEventListener('uncapturederror', (event) => {
        const err = (event as GPUUncapturedErrorEvent).error;
        console.error('[webgpu-ed25519] uncaptured GPU error:', err.message);
    });
    return { adapter, device };
}

