import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import packageJson from './package.json'
const host = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      TanStackRouterVite({
        target: 'react',
        autoCodeSplitting: true,
        routeFileIgnorePattern: '.((test).ts)|test-page',
      }),
      react(),
      tailwindcss(),
      nodePolyfills({
        include: ['path'],
        globals: {
          Buffer: false,
          global: false,
          process: false,
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@janhq/core': path.resolve(__dirname, '../core/src/index.ts'),
        '@janhq/conversational-extension': path.resolve(__dirname, '../extensions/conversational-extension/src/index.ts'),
      },
    },
    define: {
      IS_TAURI: JSON.stringify(process.env.IS_TAURI),
      IS_DEV: JSON.stringify(process.env.IS_DEV),
      // Crash reporting is Radium's own and opt-in. The DSN comes only from
      // the build environment (the optional `SENTRY_DSN` CI secret); with none
      // set, `lib/crash-reporting.ts` never initialises the SDK.
      SENTRY_DSN: JSON.stringify(env.SENTRY_DSN ?? ''),
      SENTRY_RELEASE: JSON.stringify(env.SENTRY_RELEASE ?? ''),
      IS_WEB_APP: JSON.stringify(false),
      IS_MACOS: JSON.stringify(
        process.env.TAURI_ENV_PLATFORM?.includes('darwin') ?? false
      ),
      IS_WINDOWS: JSON.stringify(
        process.env.TAURI_ENV_PLATFORM?.includes('windows') ?? false
      ),
      IS_LINUX: JSON.stringify(
        process.env.TAURI_ENV_PLATFORM?.includes('linux') ?? false
      ),
      IS_IOS: JSON.stringify(
        process.env.TAURI_ENV_PLATFORM?.includes('ios') ?? false
      ),
      IS_ANDROID: JSON.stringify(
        process.env.TAURI_ENV_PLATFORM?.includes('android') ?? false
      ),
      PLATFORM: JSON.stringify(process.env.TAURI_ENV_PLATFORM),

      VERSION: JSON.stringify(packageJson.version),

      // Hardcoded, not read from the environment: Radium never auto-updates.
      // The endpoint the updater checked is upstream's, so accepting an update
      // replaced this fork with Atomic Chat. There is deliberately no env var
      // to switch this back on - the Tauri updater plugin, its endpoint and
      // the Rust updater module have all been removed, so a `false` here would
      // only produce a button that cannot work. See
      // `docs/decisions/2026-09-12-radium-never-auto-updates.md`.
      AUTO_UPDATER_DISABLED: JSON.stringify(true),
      FORCE_ONBOARDING: JSON.stringify(
        process.env.FORCE_ONBOARDING === 'true' ||
          env.FORCE_ONBOARDING === 'true'
      ),
      // Dev-only (`make dev-fresh`): wipes webview localStorage once per app
      // launch so every startup runs the fresh-install path (onboarding,
      // turboquant disabled, upstream default). false in every shipped build.
      FRESH_INSTALL: JSON.stringify(
        process.env.FRESH_INSTALL === 'true' || env.FRESH_INSTALL === 'true'
      ),
      // Dev-only: pins the onboarding hardware tier so the low-spec
      // recommendations can be reviewed on a machine that is not low-spec.
      // '' in every shipped build, which leaves detection untouched.
      FORCE_HARDWARE_TIER: JSON.stringify(
        process.env.FORCE_HARDWARE_TIER ?? env.FORCE_HARDWARE_TIER ?? ''
      ),
      UPDATE_CHECK_INTERVAL_MS: JSON.stringify(
        Number(env.UPDATE_CHECK_INTERVAL_MS) || 60 * 60 * 1000
      ),
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: 'ws',
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell vite to ignore watching `src-tauri`
        ignored: ['**/src-tauri/**'],
        usePolling: true
      },
    },
  }
})
