/**
 * On Windows the main window has no native title bar (decorations: false), so
 * the app must draw Minimize, Maximize and Close itself. The v2.0.35 upstream
 * sync once took upstream's __root.tsx and silently dropped those controls;
 * the component test kept passing because it rendered WindowControls on its
 * own, and no build since could be closed, minimised or maximised.
 *
 * These pin the wiring rather than the component: while decorations stay off,
 * the root layout has to wrap the app in WindowFrame, and WindowFrame has to
 * render WindowControls.
 *
 * See tracker Task 23 and decisions D30 and D35 (a slim strip with no line under it).
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8')

const mainWindow = JSON.parse(
  read('src-tauri/tauri.windows.conf.json')
).app.windows.find((window) => window.label === 'main')

test('the Windows main window is configured', () => {
  assert.ok(mainWindow, 'tauri.windows.conf.json has no window labelled main')
})

test('without a native title bar, the root layout wraps the app in WindowFrame', () => {
  if (mainWindow.decorations !== false) return
  const root = read('web-app/src/routes/__root.tsx')
  const appLayoutStart = root.indexOf('const AppLayout')
  const appLayoutEnd = root.indexOf('const LogsLayout')
  assert.ok(
    appLayoutStart >= 0 && appLayoutEnd > appLayoutStart,
    'AppLayout not found'
  )
  assert.ok(
    root.slice(appLayoutStart, appLayoutEnd).includes('<WindowFrame>'),
    'AppLayout no longer renders <WindowFrame>, so Windows users lose Minimize, Maximize and Close'
  )
})

test('WindowFrame renders the window controls', () => {
  if (mainWindow.decorations !== false) return
  const frame = read('web-app/src/components/WindowFrame.tsx')
  assert.ok(
    frame.includes('<WindowControls'),
    'WindowFrame no longer renders <WindowControls>'
  )
})

test('the layout makes room for the title bar, so pages are not cut off', () => {
  if (mainWindow.decorations !== false) return
  const frame = read('web-app/src/components/WindowFrame.tsx')
  const css = read('web-app/src/index.css')
  assert.ok(
    frame.includes('data-window-chrome'),
    'WindowFrame no longer marks its scope with data-window-chrome'
  )
  for (const rule of [
    '[data-window-chrome] .h-svh',
    '[data-window-chrome] .min-h-svh',
    '[data-window-chrome] .fixed.inset-y-0',
  ]) {
    assert.ok(
      css.includes(rule),
      `index.css lost "${rule}" - full-height pages would lose their bottom 2rem under the title bar`
    )
  }
})

test('the title bar is slim and has no line under it', () => {
  if (mainWindow.decorations !== false) return
  const frame = read('web-app/src/components/WindowFrame.tsx')
  const css = read('web-app/src/index.css')
  assert.ok(
    css.includes('--window-chrome-height: 2rem;'),
    'the title bar height changed; the user asked for a slim 2rem strip (D35)'
  )
  assert.ok(
    !/border-b/.test(frame),
    'the title bar has a line under it again; the user asked for none (D35)'
  )
})
