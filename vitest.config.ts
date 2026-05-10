import { defineConfig } from 'vitest/config'

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
    ],
  },
})
