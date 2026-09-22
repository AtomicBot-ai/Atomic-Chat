/**
 * Owns the desktop app process for a test: start, attach a WebDriver session
 * to the server embedded in the `e2e` build, restart on the same profile, stop.
 *
 * The harness owns the process rather than a WebdriverIO service because the
 * scenarios need exactly that control: a relaunch that keeps the profile, a
 * launch that is expected to refuse, and a hard stop — closing the window does
 * not end the app on macOS, it hides to the tray.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { remote, type Browser } from 'webdriverio'
import { APP_BINARY_NAME, inheritedEnvKeys, listenersOn } from './platform.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** `make build-app-e2e` writes here; a separate target dir keeps the app's
 *  orphan reaper, which scans the build's resource dir, away from a dev build. */
export const APP_BINARY = resolve(
  // Normalised: an app that restarts itself shows up in the process list under
  // its canonical path, and one given here as `a/../b` would not be recognised
  // as this suite's — it would outlive the run and, holding the single-instance
  // socket, make the next launch exit at once.
  process.env.ATOMIC_E2E_APP_BIN ?? join(REPO_ROOT, 'src-tauri/target/e2e/debug', APP_BINARY_NAME)
)

const DRIVER_READY_TIMEOUT_MS = 60_000
/**
 * How long a WebDriver command may go unanswered. The client's defaults — two
 * minutes, three times — outlast every test's own limit, so a command the app
 * accepted and never answered ended as a bare "test timed out" with no artifacts
 * and no hint of which command it was. Nothing the embedded driver does takes
 * half a minute; past that the command fails, by name.
 */
const DRIVER_PATIENCE = { connectionRetryTimeout: 30_000, connectionRetryCount: 1 }
const STOP_GRACE_MS = 5_000

export interface RunningApp {
  child: ChildProcess
  browser: Browser
  driverPort: number
  /** Everything the app wrote to stdout and stderr, for failure artifacts. */
  output: () => string
  stop: () => Promise<void>
}

export async function freePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  server.close()
  await once(server, 'close')
  return port
}

/** The app's environment is built up from a short allowlist, never inherited. */
export function appEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of inheritedEnvKeys()) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return { ...env, ...extra }
}

/** `DATA_ROOT_ENV` in src-tauri/src/core/e2e.rs: present only in a build that
 *  refuses to start without a root and gives each root its own WebKit store. */
const ISOLATION_MARKER = 'ATOMIC_E2E_DATA_ROOT'
let isolationChecked = false

/**
 * Refuses a binary that would share WebKit storage with the developer's own
 * builds — a stale build, a build without `--features e2e`, or a wrong path.
 * Such a binary rewrites the developer's webview state on every launch, so this
 * is checked before the process exists rather than noticed afterwards.
 */
function assertIsolatedBuild(): void {
  if (isolationChecked) return
  if (!readFileSync(APP_BINARY).includes(ISOLATION_MARKER)) {
    throw new Error(
      `${APP_BINARY} is not an isolating e2e build; rebuild it with \`make build-app-e2e\``
    )
  }
  isolationChecked = true
}

export function spawnApp(env: Record<string, string>): {
  child: ChildProcess
  output: () => string
} {
  assertIsolatedBuild()
  const chunks: string[] = []
  const child = spawn(APP_BINARY, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.on('data', (data: Buffer) => chunks.push(data.toString()))
  child.stderr?.on('data', (data: Buffer) => chunks.push(data.toString()))
  return { child, output: () => chunks.join('') }
}

async function waitForDriver(
  port: number,
  child: ChildProcess,
  output: () => string
): Promise<void> {
  const deadline = Date.now() + DRIVER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `the app exited (code ${child.exitCode}, signal ${child.signalCode}) before its WebDriver server came up\n${output()}`
      )
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`)
      if (response.ok) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(
    `no WebDriver server on 127.0.0.1:${port} after ${DRIVER_READY_TIMEOUT_MS} ms\n${output()}`
  )
}

export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  // Closing the window would not do: on macOS the app hides to the tray. Node
  // maps both signals to TerminateProcess on Windows, where the first one ends it.
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS)
  await exited
  clearTimeout(timer)
}

/**
 * Follows the app through a restart it performs itself (after relocating its
 * data folder, say). The new process is the old one's child, not the harness's,
 * and inherits its environment — so the WebDriver server comes back on the same
 * port, and the session is simply attached again.
 */
export async function followRelaunch(app: RunningApp): Promise<void> {
  if (app.child.exitCode === null && app.child.signalCode === null) {
    await Promise.race([once(app.child, 'exit'), new Promise((r) => setTimeout(r, 60_000))])
  }
  if (app.child.exitCode === null && app.child.signalCode === null) {
    throw new Error('the app did not restart itself within 60 s')
  }
  await app.browser.deleteSession().catch(() => undefined)
  const deadline = Date.now() + DRIVER_READY_TIMEOUT_MS
  for (;;) {
    const up = await fetch(`http://127.0.0.1:${app.driverPort}/status`).then((r) => r.ok, () => false)
    if (up) break
    if (Date.now() > deadline) throw new Error(`the restarted app never served WebDriver on ${app.driverPort}\n${app.output()}`)
    await new Promise((r) => setTimeout(r, 250))
  }
  app.browser = await remote({
    hostname: '127.0.0.1',
    port: app.driverPort,
    path: '/',
    logLevel: 'warn',
    ...DRIVER_PATIENCE,
    waitforTimeout: 15_000,
    capabilities: {},
  })
  await waitForSplashToGo(app.browser)
}

let launches = 0

/**
 * Where the next window goes. Workers run side by side and each cascades by
 * its number; within one worker the sessions come one after another, and the
 * window of the one just ended may still be on its way out — kept on top, at
 * exactly the place the next one would open, which then gets no animation
 * frames until it is gone. So consecutive launches of one worker cascade too.
 */
function windowSlot(): number {
  const worker = Number(process.env.VITEST_POOL_ID ?? '1') || 1
  const slot = ((worker - 1 + (launches % 4) * 4) % 16) + 1
  launches += 1
  return slot
}

export async function launchApp(extraEnv: Record<string, string>): Promise<RunningApp> {
  const driverPort = await freePort()
  const { child, output } = spawnApp(
    appEnv({
      ...extraEnv,
      TAURI_WEBDRIVER_PORT: String(driverPort),
      // Workers run side by side, each with its window kept on top; the build
      // cascades them by this number so that none is covered completely.
      ATOMIC_E2E_WINDOW_SLOT: String(windowSlot()),
    })
  )
  try {
    await waitForDriver(driverPort, child, output)
    const browser = await remote({
      hostname: '127.0.0.1',
      port: driverPort,
      path: '/',
      logLevel: 'warn',
      ...DRIVER_PATIENCE,
      // Element commands wait for their element instead of failing on the first
      // look: lists load after the shell renders, and popovers animate in.
      waitforTimeout: 15_000,
      capabilities: {},
    })
    await waitForSplashToGo(browser)
    const app: RunningApp = {
      child,
      browser,
      driverPort,
      output,
      stop: async () => {
        await app.browser.deleteSession().catch(() => undefined)
        await stopProcess(child)
        // An app that restarted itself is no longer this process's child, but it
        // is still this session's: the restart inherits the environment, so it
        // serves WebDriver on the same port. Found by that port — not by the
        // binary — so that other sessions' apps, running beside it, are left alone.
        const mine = () => listenersOn(driverPort)
        for (const pid of mine()) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // exited meanwhile
          }
        }
        // A kill is a request; the next launch on this root must not meet a
        // process that is still going down.
        for (let waited = 0; mine().length > 0 && waited < 10_000; waited += 100) {
          await new Promise((r) => setTimeout(r, 100))
        }
      },
    }
    return app
  } catch (error) {
    await stopProcess(child)
    throw error
  }
}

/**
 * The app covers itself with a full-window splash overlay and removes it from
 * an animation frame. A window that is not being rendered — minimised, on
 * another Space, the display asleep — gets no frames, so the overlay stays and
 * takes every click meant for the UI under it. Better said once, here, than
 * discovered as "element not clickable" in whichever scenario ran at the time.
 */
async function waitForSplashToGo(browser: Browser): Promise<void> {
  await browser.$('#initial-loader').waitForExist({
    reverse: true,
    timeout: 60_000,
    timeoutMsg:
      'the splash overlay never went away: the app window is not being rendered. Keep it on a visible Space with the display awake.',
  })
}

/** Calls a real Tauri command from the page, the way the frontend does. */
export async function invoke<T>(
  browser: Browser,
  command: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const result = (await browser.execute(
    async (cmd: string, payload: Record<string, unknown>) => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (c: string, a: Record<string, unknown>) => Promise<unknown>
        }
      }).__TAURI_INTERNALS__
      try {
        return { ok: true, value: await internals.invoke(cmd, payload) }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    command,
    args
  )) as { ok: true; value: T } | { ok: false; error: string }
  if (!result.ok) throw new Error(`${command} failed: ${result.error}`)
  return result.value
}
