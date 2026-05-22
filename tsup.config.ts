import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'vanity/index': 'src/vanity/index.ts',
    'primitives/index': 'src/primitives/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
  loader: {
    '.wgsl': 'text',
  },
  treeshake: true,
  splitting: false,
  // external marks .wgsl as external for the rollup DTS pass (which cannot inline non-TS files)
  external: [/\.wgsl$/],
  // noExternal overrides external for the esbuild (ESM) pass so the loader inlines them
  noExternal: [/\.wgsl$/],
});
