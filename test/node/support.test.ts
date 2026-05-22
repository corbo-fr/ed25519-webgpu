import { describe, expect, it } from 'vitest';
import { getAdapterInfo, isWebGPUSupported } from '../../src/support.js';

describe('isWebGPUSupported — node env', () => {
    it('returns false when navigator is not defined', () => {
        expect(isWebGPUSupported()).toBe(false);
    });
});

describe('getAdapterInfo — node env', () => {
    it('returns null when WebGPU is not supported', async () => {
        expect(await getAdapterInfo()).toBeNull();
    });
});
