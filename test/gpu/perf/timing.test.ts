/**
 * GPU timing breakdown — understand where time goes in the vanity pipeline.
 *
 * Run with: pnpm test:perf
 *
 * Each test logs detailed timings to identify bottlenecks:
 *   - CPU seed generation
 *   - GPU writeBuffer (CPU→GPU transfer)
 *   - GPU compute (mapAsync wall time)
 *   - Readback latency
 *   - Scaling vs batch size (linear? fixed overhead?)
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { Ed25519GPU } from '../../../src/index.js';
import { createVanityBufs, destroyVanityBufs, runVanityBatch } from '../../../src/core/vanity.js';
import { compilePipelines } from '../../../src/core/pipelines.js';

const ZERO8 = new Uint32Array(8);
const MAX8  = new Uint32Array(8).fill(0xFFFFFFFF);
const NO_FILTER = { L: ZERO8, H: MAX8, hasPrefix: false, suffixMod: 0, suffixVal: 0, hasSuffix: false };

function ms(n: number) { return `${n.toFixed(1)}ms`; }
function kps(keys: number, elapsed: number) { return `${(keys / elapsed * 1000).toFixed(0)} keys/s`; }

function randomBytes(n: number): Uint8Array {
    const buf = new Uint8Array(n);
    const CHUNK = 65536;
    for (let off = 0; off < n; off += CHUNK)
        crypto.getRandomValues(buf.subarray(off, Math.min(off + CHUNK, n)));
    return buf;
}

describe('GPU timing breakdown', () => {
    let gpu: Ed25519GPU;
    let device: GPUDevice;
    let pipelines: any;
    let gTableBuf: GPUBuffer;

    beforeEach(async () => {
        gpu = await Ed25519GPU.create();
        device    = (gpu as any).device;
        pipelines = (gpu as any).pipelines;
        gTableBuf = (gpu as any).gTableBuf;
    });

    afterEach(() => gpu.destroy());

    // ── 1. CPU seed generation ──────────────────────────────────────────────

    it('1. CPU seed generation — 65536 × individual vs 1 bulk call', () => {
        const N = 65536;

        // Individual calls (OLD approach)
        const t0 = performance.now();
        for (let i = 0; i < N; i++) crypto.getRandomValues(new Uint8Array(32));
        const t1 = performance.now();

        // Bulk (NEW approach)
        const seedsFlat = new Uint8Array(N * 32);
        const t2 = performance.now();
        const CHUNK = 65536;
        for (let off = 0; off < seedsFlat.byteLength; off += CHUNK)
            crypto.getRandomValues(seedsFlat.subarray(off, Math.min(off + CHUNK, seedsFlat.byteLength)));
        const t3 = performance.now();

        console.log(`[1] Seed gen — individual: ${ms(t1 - t0)}, bulk: ${ms(t3 - t2)}, savings: ${ms((t1-t0)-(t3-t2))}`);
    });

    // ── 2. GPU baseline — empty compute pass overhead ──────────────────────

    it('2. Empty GPU round-trip (no compute, just mapAsync latency)', async () => {
        const stagingBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const srcBuf     = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });

        const RUNS = 5;
        const times: number[] = [];
        for (let r = 0; r < RUNS; r++) {
            const enc = device.createCommandEncoder();
            enc.copyBufferToBuffer(srcBuf, 0, stagingBuf, 0, 4);
            const t0 = performance.now();
            device.queue.submit([enc.finish()]);
            await stagingBuf.mapAsync(GPUMapMode.READ);
            stagingBuf.unmap();
            const t1 = performance.now();
            times.push(t1 - t0);
        }

        stagingBuf.destroy();
        srcBuf.destroy();
        const avg = times.reduce((a, b) => a + b) / RUNS;
        console.log(`[2] Empty mapAsync round-trip: avg=${ms(avg)} [${times.map(ms).join(', ')}]`);
    });

    // ── 3. writeBuffer cost — CPU→GPU transfer for 2MB seeds ───────────────

    it('3. writeBuffer 2MB (65536 seeds)', async () => {
        const N   = 65536;
        const data = randomBytes(N * 32);
        const buf  = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

        const RUNS = 5;
        const times: number[] = [];
        for (let r = 0; r < RUNS; r++) {
            const t0 = performance.now();
            device.queue.writeBuffer(buf, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
            // onSubmittedWorkDone() to flush and measure actual transfer time
            await device.queue.onSubmittedWorkDone();
            const t1 = performance.now();
            times.push(t1 - t0);
        }

        buf.destroy();
        const avg = times.reduce((a, b) => a + b) / RUNS;
        console.log(`[3] writeBuffer 2MB: avg=${ms(avg)} [${times.map(ms).join(', ')}]`);
    });

    // ── 4. GPU compute only — measure via onSubmittedWorkDone ───────────────

    it('4. GPU compute time (onSubmittedWorkDone) — N=65536', async () => {
        const N     = 65536;
        const bufs  = createVanityBufs(device, pipelines, gTableBuf, N);
        const seeds = randomBytes(N * 32);

        device.queue.writeBuffer(bufs.seedBuf,     0, seeds.buffer as ArrayBuffer, seeds.byteOffset, seeds.byteLength);
        device.queue.writeBuffer(bufs.hitCountBuf, 0, new Uint32Array([0]));
        device.queue.writeBuffer(bufs.uniformBuf,  0, new Uint32Array(20));
        await device.queue.onSubmittedWorkDone(); // flush writes

        const RUNS = 3;
        const times: number[] = [];
        for (let r = 0; r < RUNS; r++) {
            const enc  = device.createCommandEncoder();
            const pass = enc.beginComputePass();
            pass.setPipeline(pipelines.vanity);
            pass.setBindGroup(0, bufs.bindGroup);
            pass.dispatchWorkgroups(Math.ceil(N / 64));
            pass.end();
            const t0 = performance.now();
            device.queue.submit([enc.finish()]);
            await device.queue.onSubmittedWorkDone();
            const t1 = performance.now();
            times.push(t1 - t0);
        }

        destroyVanityBufs(bufs);
        const avg = times.reduce((a, b) => a + b) / RUNS;
        console.log(`[4] GPU compute (vanity, N=${N}): avg=${ms(avg)} → ${kps(N, avg)} [${times.map(ms).join(', ')}]`);
    });

    // ── 5. Full runVanityBatch — compute + readback ─────────────────────────

    it('5. Full runVanityBatch — compute + readback breakdown', async () => {
        const N     = 65536;
        const bufs  = createVanityBufs(device, pipelines, gTableBuf, N);
        const seeds = randomBytes(N * 32);

        // warm-up
        await runVanityBatch(device, pipelines, bufs, seeds, NO_FILTER);

        const RUNS = 5;
        const timesCompute: number[]  = [];
        const timesMapAsync: number[] = [];
        const timesTotal: number[]    = [];

        for (let r = 0; r < RUNS; r++) {
            const CHUNK = 65536;
            for (let off = 0; off < seeds.byteLength; off += CHUNK)
                crypto.getRandomValues(seeds.subarray(off, Math.min(off + CHUNK, seeds.byteLength)));

            device.queue.writeBuffer(bufs.seedBuf,     0, seeds.buffer as ArrayBuffer, seeds.byteOffset, seeds.byteLength);
            device.queue.writeBuffer(bufs.hitCountBuf, 0, new Uint32Array([0]));
            device.queue.writeBuffer(bufs.uniformBuf,  0, new Uint32Array(20));

            // Submit compute-only, measure GPU time
            const enc  = device.createCommandEncoder();
            const pass = enc.beginComputePass();
            pass.setPipeline(pipelines.vanity);
            pass.setBindGroup(0, bufs.bindGroup);
            pass.dispatchWorkgroups(Math.ceil(N / 64));
            pass.end();
            enc.copyBufferToBuffer(bufs.hitCountBuf, 0, bufs.countStagingBuf, 0, 4);
            const t0 = performance.now();
            device.queue.submit([enc.finish()]);
            const t1 = performance.now();
            await bufs.countStagingBuf.mapAsync(GPUMapMode.READ);
            const t2 = performance.now();
            bufs.countStagingBuf.unmap();

            timesCompute.push(t1 - t0);   // JS encode + submit (CPU only)
            timesMapAsync.push(t2 - t1);  // GPU compute + copy + map latency
            timesTotal.push(t2 - t0);
        }

        destroyVanityBufs(bufs);
        const avgTotal   = timesTotal.reduce((a, b) => a + b) / RUNS;
        const avgCompute = timesCompute.reduce((a, b) => a + b) / RUNS;
        const avgMap     = timesMapAsync.reduce((a, b) => a + b) / RUNS;
        console.log(`[5] submit (CPU):   avg=${ms(avgCompute)} [${timesCompute.map(ms).join(', ')}]`);
        console.log(`[5] mapAsync (GPU): avg=${ms(avgMap)}     [${timesMapAsync.map(ms).join(', ')}]`);
        console.log(`[5] total:          avg=${ms(avgTotal)} → ${kps(N, avgTotal)}`);
    });

    // ── 6. Scaling: does batch time scale linearly with N? ──────────────────

    it('6. Scaling: batch time vs N (linear = GPU; flat offset = overhead)', async () => {
        const sizes = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

        console.log(`[6] N       | total(ms) | GPU mapAsync | keys/s`);
        console.log(`    --------|-----------|--------------|-------`);

        for (const N of sizes) {
            const bufs  = createVanityBufs(device, pipelines, gTableBuf, N);
            const seeds = randomBytes(N * 32);

            // warm-up
            await runVanityBatch(device, pipelines, bufs, seeds, NO_FILTER);

            device.queue.writeBuffer(bufs.seedBuf,     0, seeds.buffer as ArrayBuffer, seeds.byteOffset, seeds.byteLength);
            device.queue.writeBuffer(bufs.hitCountBuf, 0, new Uint32Array([0]));
            device.queue.writeBuffer(bufs.uniformBuf,  0, new Uint32Array(20));

            const enc  = device.createCommandEncoder();
            const pass = enc.beginComputePass();
            pass.setPipeline(pipelines.vanity);
            pass.setBindGroup(0, bufs.bindGroup);
            pass.dispatchWorkgroups(Math.ceil(N / 64));
            pass.end();
            enc.copyBufferToBuffer(bufs.hitCountBuf, 0, bufs.countStagingBuf, 0, 4);

            const t0 = performance.now();
            device.queue.submit([enc.finish()]);
            await bufs.countStagingBuf.mapAsync(GPUMapMode.READ);
            const t1 = performance.now();
            bufs.countStagingBuf.unmap();

            destroyVanityBufs(bufs);
            const elapsed = t1 - t0;
            console.log(`    ${String(N).padEnd(7)} | ${ms(elapsed).padEnd(9)} | (mapAsync)     | ${kps(N, elapsed)}`);
        }
    });
});
