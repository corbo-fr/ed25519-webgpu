export function isWebGPUSupported(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export async function getAdapterInfo(): Promise<{ vendor: string; architecture: string; description: string } | null> {
    if (!isWebGPUSupported()) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const info = await adapter.requestAdapterInfo();
    return { vendor: info.vendor, architecture: info.architecture, description: info.description };
}
