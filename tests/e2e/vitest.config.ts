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
    // `expect.poll` gives up after one second unless told otherwise, which a
    // real window on a busy machine does not always meet: a switch that flips, a
    // file that lands. Waits that mean "soon" get a limit that means it.
    expect: { poll: { timeout: 15_000, interval: 250 } },
  },
})
