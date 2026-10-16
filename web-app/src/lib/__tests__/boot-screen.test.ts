/**
 * The boot screen (index.html + public/boot.js).
 *
 * It used to be a spinning logo removed on a 200 ms timer, whatever the app
 * had drawn by then; when startup stalled the window stayed black, with no
 * title bar to move or close it. These pin the replacement: it stays up until
 * the app says it has drawn, writes its steps to app.log, turns into a panel
 * that says where startup stopped, and can always be closed.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Script } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const webApp = path.resolve(__dirname, '../../..')
const indexHtml = readFileSync(path.join(webApp, 'index.html'), 'utf8')
const bootScript = readFileSync(path.join(webApp, 'public/boot.js'), 'utf8')
const loaderCss = readFileSync(path.join(webApp, 'src/loader.css'), 'utf8')
const bootScreenScript = new Script(bootScript, { filename: 'public/boot.js' })

type Call = { command: string; args: Record<string, unknown> }

/** index.html's <body>, parsed as the browser would, minus its scripts. */
function loadIndexBody() {
  const parsed = new DOMParser().parseFromString(indexHtml, 'text/html')
  parsed.querySelectorAll('script').forEach((script) => script.remove())
  document.body.className = ''
  document.body.replaceChildren(
    ...[...parsed.body.childNodes].map((node) => document.importNode(node, true))
  )
}

function mountBootScreen(options: { userAgent?: string; windowLabel?: string } = {}) {
  loadIndexBody()
  const calls: Call[] = []
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args })
      if (command === 'get_app_configurations') {
        return Promise.resolve({ data_folder: 'C:\\Users\\me\\AppData\\Roaming\\Radium\\data' })
      }
      return Promise.resolve(null)
    },
    metadata: { currentWindow: { label: options.windowLabel ?? 'main' } },
  }
  if (options.userAgent) {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(options.userAgent)
  }
  // Runs the shipped file as the page would: a classic script, top level.
  bootScreenScript.runInThisContext()
  const loader = () => document.getElementById('initial-loader')
  const logLines = () =>
    calls
      .filter((call) => call.command === 'plugin:log|log')
      .map((call) => String(call.args.message))
  return { calls, loader, logLines }
}

const click = (action: string) =>
  (document.querySelector(`[data-boot-action="${action}"]`) as HTMLElement).click()

describe('boot screen', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete window.__radiumBoot
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    localStorage.clear()
  })

  it('does not spin', () => {
    expect(loaderCss).not.toMatch(/animation\s*:/)
    expect(loaderCss).not.toMatch(/@keyframes/)
    expect(loaderCss).not.toMatch(/rotate\(/)
    expect(indexHtml).not.toMatch(/loader-logo-spin/)
  })

  it('is semi-transparent and frosted, inside the window', () => {
    expect(loaderCss).toMatch(/--boot-bg:\s*rgb\([^)]*\/\s*\d+%\)/)
    expect(loaderCss).toMatch(/backdrop-filter:\s*blur\(/)
  })

  it('loads before the app bundle, as a classic script', () => {
    const boot = indexHtml.indexOf('<script src="/boot.js"></script>')
    const bundle = indexHtml.indexOf('<script type="module" src="/src/main.tsx">')
    expect(boot).toBeGreaterThan(-1)
    expect(boot).toBeLessThan(bundle)
  })

  it('shows each step and stays up until the app says it has drawn', async () => {
    const { loader, logLines } = mountBootScreen()
    window.__radiumBoot!.step('extensions', 'Loading extensions…')
    expect(document.getElementById('boot-status')!.textContent).toBe('Loading extensions…')

    await vi.advanceTimersByTimeAsync(10_000)
    expect(loader()).not.toBeNull()
    expect(document.body.classList.contains('loaded')).toBe(false)

    window.__radiumBoot!.ready('test')
    expect(document.body.classList.contains('loaded')).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(loader()).toBeNull()

    const lines = logLines()
    expect(lines.some((line) => line.includes('extensions: Loading extensions…'))).toBe(true)
    expect(lines.some((line) => /\[boot\] ready \(test\) after \d+ ms/.test(line))).toBe(true)
  })

  it('writes a heartbeat to app.log while startup is unfinished, and stops once ready', async () => {
    const { logLines } = mountBootScreen()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(logLines().filter((line) => line.includes('still starting')).length).toBe(2)
    window.__radiumBoot!.ready()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(logLines().filter((line) => line.includes('still starting')).length).toBe(2)
  })

  it('says where startup stalled when nothing moves for 20 s', async () => {
    mountBootScreen()
    window.__radiumBoot!.step('extensions:load', 'Starting extensions… waiting for llamacpp')
    const problem = document.getElementById('boot-problem')!
    await vi.advanceTimersByTimeAsync(19_999)
    expect(problem.hidden).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(problem.hidden).toBe(false)
    expect(document.getElementById('boot-problem-title')!.textContent).toMatch(/longer than usual/)
    expect(document.getElementById('boot-problem-detail')!.textContent).toMatch(/waiting for llamacpp/)

    // Progress hides it again.
    window.__radiumBoot!.step('layout', 'Almost ready…')
    expect(problem.hidden).toBe(true)
  })

  it('"Keep waiting" hides the panel and waits another 20 s', async () => {
    mountBootScreen()
    await vi.advanceTimersByTimeAsync(20_000)
    click('wait')
    expect(document.getElementById('boot-problem')!.hidden).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(document.getElementById('boot-problem')!.hidden).toBe(false)
  })

  it('reports an early error when nothing moves after it', async () => {
    mountBootScreen()
    window.dispatchEvent(
      new ErrorEvent('error', { error: new TypeError('a is not a function'), message: 'a is not a function' })
    )
    await vi.advanceTimersByTimeAsync(8_000)
    expect(document.getElementById('boot-problem')!.hidden).toBe(false)
    expect(document.getElementById('boot-problem-title')!.textContent).toMatch(/didn't finish starting/)
    expect(document.getElementById('boot-problem-errors')!.textContent).toMatch(/a is not a function/)
  })

  it('does not report an early error the app recovers from', async () => {
    mountBootScreen()
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('flaky'), message: 'flaky' }))
    window.__radiumBoot!.step('services', 'Loading services…')
    await vi.advanceTimersByTimeAsync(8_000)
    expect(document.getElementById('boot-problem')!.hidden).toBe(true)
  })

  it('draws its own Minimize and Close on Windows, and they work', () => {
    const { calls, loader } = mountBootScreen({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/140',
    })
    expect(loader()!.getAttribute('data-chrome')).toBe('custom')
    expect(document.querySelector('[data-tauri-drag-region]')).not.toBeNull()
    click('minimize')
    click('close')
    expect(calls.map((call) => call.command)).toEqual(
      expect.arrayContaining(['plugin:window|minimize', 'plugin:window|close'])
    )
  })

  it('leaves the logs and system-monitor windows their native title bar', () => {
    const { loader } = mountBootScreen({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/140',
      windowLabel: 'logs-app-window',
    })
    expect(loader()!.getAttribute('data-chrome')).toBeNull()
  })

  it('leaves window buttons to the OS elsewhere', () => {
    const { loader } = mountBootScreen({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15',
    })
    expect(loader()!.getAttribute('data-chrome')).toBeNull()
  })

  it('opens the log and restarts from the panel', async () => {
    const { calls } = mountBootScreen()
    click('log')
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toContainEqual({
      command: 'plugin:opener|reveal_item_in_dir',
      args: { paths: ['C:\\Users\\me\\AppData\\Roaming\\Radium\\data\\logs\\app.log'] },
    })
    click('restart')
    expect(calls.some((call) => call.command === 'relaunch')).toBe(true)
  })

  it('follows the theme the user chose in Radium', () => {
    localStorage.setItem('theme', JSON.stringify({ state: { activeTheme: 'light' } }))
    const { loader } = mountBootScreen()
    expect(loader()!.getAttribute('data-theme')).toBe('light')
  })
})
