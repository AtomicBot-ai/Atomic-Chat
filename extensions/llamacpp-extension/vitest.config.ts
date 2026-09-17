import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const plugin = (name: string) =>
  fileURLToPath(new URL(`../../src-tauri/plugins/${name}/guest-js/index.ts`, import.meta.url))

export default defineConfig({
  // The plugin packages point at a `dist-js` build that exists only after `yarn build:tauri:plugin:api`.
  // Tests mock them, but Vite resolves the entry first; the sources resolve without a build.
  resolve: {
    alias: {
      '@janhq/tauri-plugin-llamacpp-api': plugin('tauri-plugin-llamacpp'),
      '@janhq/tauri-plugin-hardware-api': plugin('tauri-plugin-hardware'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.ts', 'src/test/**/*'],
    },
  },
})
