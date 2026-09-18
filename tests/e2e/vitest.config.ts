import { defineConfig } from 'vitest/config'

// One app at a time: every spec launches the real desktop binary, which owns a
// window, a WebDriver port and a core daemon.
export default defineConfig({
  test: {
    include: ['desktop/**/*.spec.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
