import { defineConfig, type Plugin, type PluginOption } from 'vitest/config'

import appConfig from './vite.config'
import jsdomConfig from './vitest.config'

/**
 * The real-browser layout suite: `yarn test:layout` / `make test-layout`.
 *
 * jsdom has no layout engine, so a test there cannot see a dialog that grows a
 * horizontal scrollbar, a readout that wraps, or a button pushed out of its
 * card — the bugs `docs/ui-layout-rules.md` exists for. This config runs the
 * `*.layout.test.tsx` files in headless Chromium through Vitest browser mode
 * (Playwright), with the app's own Vite pipeline — Tailwind 4, the `@`
 * aliases, the `path` polyfill — so the styles under measurement are the ones
 * the app ships. The setup file loads `src/index.css` and waits for Inter, so
 * every number a test reads comes from the real font.
 *
 * Browser mode over Playwright e2e: the tests render one primitive with real
 * props, exactly like the jsdom suite, and need no built app, no Tauri, no
 * navigation. They read numbers off `getBoundingClientRect`, so a failure
 * names the pixel that is wrong instead of handing over a screenshot.
 */

/** The app config is a function; ask it for the dev-server variant. */
const app = appConfig({ mode: 'test', command: 'serve' })

/**
 * Everything the app config wires except TanStack Router, whose generator
 * rewrites `src/routeTree.gen.ts` on start — a side effect a test run must
 * not have — and whose route tree nothing under test imports.
 */
function isRouterPlugin(plugin: PluginOption): boolean {
  return (
    typeof plugin === 'object' &&
    plugin !== null &&
    'name' in plugin &&
    typeof (plugin as Plugin).name === 'string' &&
    /^tanstack(-router)?:/.test((plugin as Plugin).name)
  )
}

const plugins = (app.plugins ?? [])
  .flat()
  .filter((plugin) => plugin && !isRouterPlugin(plugin))

export default defineConfig({
  plugins,
  resolve: app.resolve,
  // The app's defines read Tauri's env, which is not set here; the jsdom
  // suite's test-time values (`IS_MACOS: false`, `VERSION: 'test'`, ...)
  // are what a component sees in a test either way.
  define: { ...app.define, ...jsdomConfig.define },
  // The app pins Vite to port 1420 with `strictPort` for Tauri; the browser
  // runner must never collide with a running `yarn dev`.
  server: { port: undefined, strictPort: false, host: false, hmr: false },
  test: {
    name: 'layout',
    include: ['src/**/*.layout.test.tsx'],
    setupFiles: ['./src/test/layout.setup.ts'],
    globals: true,
    css: true,
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      instances: [{ browser: 'chromium' }],
      // The app's default desktop window, wide enough that `sm:` applies.
      viewport: { width: 1280, height: 800 },
      // A failing layout assertion already says which pixel is off; the
      // screenshot would land in `__screenshots__` next to the test.
      screenshotFailures: false,
    },
  },
})
