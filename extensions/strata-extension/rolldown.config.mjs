import { defineConfig } from 'rolldown'
import pkgJson from './package.json' with { type: 'json' }

export default defineConfig({
  input: 'src/index.ts',
  output: {
    format: 'esm',
    file: 'dist/index.js',
  },
  platform: 'browser',
  define: {
    ENGINE: JSON.stringify(pkgJson.engine),
  },
  inject: process.env.IS_DEV
    ? {}
    : {
        fetch: ['@tauri-apps/plugin-http', 'fetch'],
      },
})
