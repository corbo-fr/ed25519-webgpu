import { describe, expect, it } from 'vitest';
import { Ed25519GPU } from '../../../src/index.js';

describe('Ed25519GPU — post-destroy', () => {
    it('derivePublicKeys rejects after destroy()', async () => {
        const gpu = await Ed25519GPU.create();
        gpu.destroy();
        const seed = crypto.getRandomValues(new Uint8Array(32));
        await expect(gpu.derivePublicKeys([seed])).rejects.toThrow();
    }, 10_000);
});
