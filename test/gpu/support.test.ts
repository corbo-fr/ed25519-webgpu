import { describe, expect, it } from 'vitest';
import { getAdapterInfo, isWebGPUSupported } from '../../src/support.js';

describe('isWebGPUSupported — browser env', () => {
    it('returns true when WebGPU is available', () => {
        expect(isWebGPUSupported()).toBe(true);
    });
});

describe('getAdapterInfo — browser env', () => {
    it('returns a non-null object with vendor, architecture and description strings', async () => {
        const info = await getAdapterInfo();
        expect(info).not.toBeNull();
        expect(typeof info!.vendor).toBe('string');
        expect(typeof info!.architecture).toBe('string');
        expect(typeof info!.description).toBe('string');
    });
});
