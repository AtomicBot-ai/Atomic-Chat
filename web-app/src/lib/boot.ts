/**
 * The app's side of the boot screen in index.html.
 *
 * `public/boot.js` runs before the bundle and owns the screen: it shows the
 * status line, keeps the screen up until `bootReady()`, writes each step to
 * app.log and turns into a "didn't finish starting" panel when startup stalls.
 * These wrappers are how the app reports progress. Every one is a no-op when
 * the boot script is absent (tests, a page that has no boot screen) and never
 * throws.
 *
 * See docs/decisions/2026-10-15-boot-screen-stays-until-the-app-has-drawn.md.
 */

type BootApi = {
  step: (id: string, label?: string) => void
  ready: (reason?: string) => void
  fail: (error: unknown, where?: string) => void
  log: (level: number, message: string) => void
}

declare global {
  interface Window {
    __radiumBoot?: BootApi
  }
}

/** tauri-plugin-log levels. */
export const BootLogLevel = {
  info: 3,
  warn: 4,
  error: 5,
} as const

function api(): BootApi | undefined {
  if (typeof window === 'undefined') return undefined
  return window.__radiumBoot
}

/** Record a startup step; `label` replaces the status line under the logo. */
export function bootStep(id: string, label?: string): void {
  try {
    api()?.step(id, label)
  } catch {
    // The boot screen is best-effort; startup must not depend on it.
  }
}

/** The app has drawn: fade the boot screen out. Safe to call more than once. */
export function bootReady(reason?: string): void {
  try {
    api()?.ready(reason)
  } catch {
    // Best-effort, as above.
  }
}

/** Startup failed in a way the app can name: show the problem panel. */
export function bootFail(error: unknown, where?: string): void {
  try {
    api()?.fail(error, where)
  } catch {
    // Best-effort, as above.
  }
}

/** One line in app.log, prefixed `[boot]`. Works after startup too. */
export function bootLog(
  message: string,
  level: (typeof BootLogLevel)[keyof typeof BootLogLevel] = BootLogLevel.info
): void {
  try {
    api()?.log(level, `[boot] ${message}`)
  } catch {
    // Best-effort, as above.
  }
}
