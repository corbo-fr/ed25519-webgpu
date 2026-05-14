export function createStorageBuffer(device: GPUDevice, size: number, data?: Uint8Array): GPUBuffer {
    const buf = device.createBuffer({
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    if (data) device.queue.writeBuffer(buf, 0, data);
    return buf;
}

export async function readbackBuffer(device: GPUDevice, srcBuf: GPUBuffer, size: number): Promise<Uint8Array> {
    const readBuf = device.createBuffer({
        size,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(srcBuf, 0, readBuf, 0, size);
    device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const data = new Uint8Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    readBuf.destroy();
    return data;
}
