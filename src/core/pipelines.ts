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

export async function compilePipelines(device: GPUDevice): Promise<Pipelines> {
    const hit = cache.get(device);
    if (hit) return hit;

    const mk = (code: string) => device.createShaderModule({ code });
    const [sha512, scalarMult, derive, vanity] = await Promise.all([
        device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module: mk(SHA512_SOURCE), entryPoint: 'main' },
        }),
        device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module: mk(SCALAR_MULT_SOURCE), entryPoint: 'main' },
        }),
        device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module: mk(DERIVE_SOURCE), entryPoint: 'main' },
        }),
        device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module: mk(VANITY_SOURCE), entryPoint: 'main' },
        }),
    ]);

    const pipelines: Pipelines = { sha512, scalarMult, derive, vanity };
    cache.set(device, pipelines);
    return pipelines;
}
