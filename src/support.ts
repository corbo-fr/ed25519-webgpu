/** Returns true if WebGPU is available in the current environment. */
export function isWebGPUSupported(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/** Returns GPU adapter info (vendor, architecture, description), or null if WebGPU is unavailable. */
export async function getAdapterInfo(): Promise<{ vendor: string; architecture: string; description: string } | null> {
    if (!isWebGPUSupported()) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const info = adapter.info;
    return { vendor: info.vendor, architecture: info.architecture, description: info.description };
}
