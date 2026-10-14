import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      // Core package - use its own vitest config
      './core',

      // Web-app package - use its own vitest config
      './web-app',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
      // Coverage is global for projects. Keep unimported production files in
      // the report, and match paths relative to this repository in Vitest 5.
      include: ['core/src/**/*.{ts,tsx}', 'web-app/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.d.ts',
        '**/src/**/*.test.ts',
        '**/src/**/*.test.tsx',
        '**/src/test/**/*',
      ],
    },
  },
})
