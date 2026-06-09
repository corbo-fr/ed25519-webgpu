import { defineConfig, type Plugin } from 'vitest/config'

const wgslPlugin: Plugin = {
  name: 'wgsl',
  transform(src, id) {
    if (id.endsWith('.wgsl')) {
      return { code: `export default ${JSON.stringify(src)}`, map: null }
    }
  },
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/node/**/*.test.ts'],
        },
      },
      {
        plugins: [wgslPlugin],
        test: {
          name: 'browser',
          include: ['test/gpu/**/*.test.ts'],
          browser: {
            enabled: true,
            name: 'chromium',
            provider: 'playwright',
            providerOptions: {
              launch: {
                args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
              },
            },
          },
        },
      },
      {
        plugins: [wgslPlugin],
        test: {
          name: 'webkit',
          include: ['test/gpu/**/*.test.ts'],
          browser: {
            enabled: true,
            name: 'webkit',
            provider: 'playwright',
          },
        },
      },
    ],
  },
})
