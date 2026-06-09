export { findVanity, findVanityRace, type VanityHit, type VanityOptions } from './finder.js';
export { encodePrefix, encodeSuffix } from './matcher.js';

import type { Ed25519GPU } from '../index.js';

/**
 * Probe the GPU across batch sizes and return the smallest one that achieves
 * ≥95% of peak throughput. Delegates to `gpu.calibrateBatchSize()`.
 *
 * @example
 * const gpu = await Ed25519GPU.create();
 * const size = await calibrateBatchSize(gpu);
 * for await (const hit of findVanity(gpu, { prefix: 'ABC', batchSize: size })) { ... }
 */
export function calibrateBatchSize(gpu: Ed25519GPU): Promise<number> {
    return gpu.calibrateBatchSize();
}
