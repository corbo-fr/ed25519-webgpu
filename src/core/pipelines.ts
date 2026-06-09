import sha512Wgsl          from '../shaders/primitives/sha512.wgsl';
import pipelineSha512Wgsl  from '../shaders/pipeline_sha512.wgsl';
import bigintWgsl          from '../shaders/primitives/bigint.wgsl';
import ffWgsl              from '../shaders/primitives/ff.wgsl';
import edWgsl              from '../shaders/primitives/edwards25519.wgsl';
import pipelineScalarWgsl  from '../shaders/pipeline_scalar_mult.wgsl';
import pipelineDeriveWgsl  from '../shaders/pipeline_derive.wgsl';
import pipelineVanityWgsl  from '../shaders/pipeline_vanity.wgsl';

const PRIM               = bigintWgsl + '\n' + ffWgsl + '\n' + edWgsl;
const SHA512_SOURCE      = sha512Wgsl + '\n' + pipelineSha512Wgsl;
const SCALAR_MULT_SOURCE = PRIM + '\n' + pipelineScalarWgsl;
const DERIVE_SOURCE      = sha512Wgsl + '\n' + PRIM + '\n' + pipelineDeriveWgsl;
const VANITY_SOURCE      = sha512Wgsl + '\n' + PRIM + '\n' + pipelineVanityWgsl;

export type Pipelines = {
    sha512: GPUComputePipeline;
    scalarMult: GPUComputePipeline;
    derive: GPUComputePipeline;
    vanity: GPUComputePipeline;
};

const cache = new WeakMap<GPUDevice, Pipelines>();

// Compile a shader module and throw a descriptive error if naga/Tint rejects it.
// Surfaces line numbers and messages from the GPU compiler — critical for Firefox/wgpu
// compatibility debugging where silent failures are common.
async function mkSafe(device: GPUDevice, code: string, label: string): Promise<GPUShaderModule> {
    const module = device.createShaderModule({ code, label });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter(m => m.type === 'error');
    if (errors.length > 0) {
        const lines = errors.map(m => `  line ${m.lineNum}: ${m.message}`).join('\n');
        throw new Error(`[webgpu-ed25519] shader "${label}" failed to compile:\n${lines}`);
    }
    return module;
}

export async function compilePipelines(device: GPUDevice): Promise<Pipelines> {
    const hit = cache.get(device);
    if (hit) return hit;

    const [sha512Mod, scalarMultMod, deriveMod, vanityMod] = await Promise.all([
        mkSafe(device, SHA512_SOURCE,      'sha512'),
        mkSafe(device, SCALAR_MULT_SOURCE, 'scalar-mult'),
        mkSafe(device, DERIVE_SOURCE,      'derive'),
        mkSafe(device, VANITY_SOURCE,      'vanity'),
    ]);

    const [sha512, scalarMult, derive, vanity] = await Promise.all([
        device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module: sha512Mod,      entryPoint: 'main' },
        }),
        device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module: scalarMultMod,  entryPoint: 'main' },
        }),
        device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module: deriveMod,      entryPoint: 'main' },
        }),
        device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module: vanityMod,      entryPoint: 'main' },
        }),
    ]);

    const pipelines: Pipelines = { sha512, scalarMult, derive, vanity };
    cache.set(device, pipelines);
    return pipelines;
}
