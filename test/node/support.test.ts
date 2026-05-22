import { describe, expect, it } from 'vitest';
import { isWebGPUSupported } from '../../src/support.js';

describe('isWebGPUSupported — node env', () => {
    it('returns false when navigator is not defined', () => {
        expect(isWebGPUSupported()).toBe(false);
    });
});
