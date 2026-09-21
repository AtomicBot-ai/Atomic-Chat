import { defineConfig } from 'vitest/config'

// Every spec launches the real desktop binary, which owns a window, a WebDriver
// port and a core daemon.
const workers = Math.max(1, Number.parseInt(process.env.E2E_WORKERS ?? '4', 10) || 4)

export default defineConfig({
  test: {
    include: ['desktop/**/*.spec.ts'],
    environment: 'node',
    // Scenario files run side by side (`E2E_WORKERS`, 4 unless set; 1 is the old
    // one-at-a-time run): each session has a root, a core, ports and an app identifier of its
    // own. Within a file scenarios still run in order.
    fileParallelism: workers > 1,
    maxWorkers: workers,
    minWorkers: 1,
    globalSetup: ['./harness/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // `expect.poll` gives up after one second unless told otherwise, which a
    // real window on a busy machine does not always meet: a switch that flips, a
    // file that lands. Waits that mean "soon" get a limit that means it.
    expect: { poll: { timeout: 15_000, interval: 250 } },
  },
})
