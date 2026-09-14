/**
 * On Windows the main window has no native title bar (decorations: false), so
 * the app must draw Minimize, Maximize and Close itself. The v2.0.35 upstream
 * sync once took upstream's __root.tsx and silently dropped those controls;
 * the component test kept passing because it rendered WindowControls on its
 * own, and no build since could be closed, minimised or maximised.
 *
 * These pin the wiring rather than the component: while decorations stay off,
 * the root layout has to wrap the app in WindowFrame, WindowFrame has to render
 * WindowControls, and the page header - where the controls sit, since the user
 * asked for no separate title bar (2026-09-14) - has to stay a drag region
 * with room kept clear for them.
 *
 * See tracker Task 23 and decision D30.
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

test('the page header can move the window and keeps room for the controls', () => {
  if (mainWindow.decorations !== false) return
  const header = read('web-app/src/containers/HeaderPage.tsx')
  assert.ok(
    header.includes('hasCustomWindowChrome'),
    'HeaderPage no longer checks for the custom window chrome'
  )
  assert.ok(
    header.includes('data-tauri-drag-region'),
    'HeaderPage is no longer a drag region, so the window cannot be moved'
  )
})

test('there is no separate title bar above the app', () => {
  if (mainWindow.decorations !== false) return
  const frame = read('web-app/src/components/WindowFrame.tsx')
  const css = read('web-app/src/index.css')
  assert.ok(
    !frame.includes('data-window-chrome') && !css.includes('[data-window-chrome]'),
    'the separate title bar is back; the user asked for the controls in the page header instead'
  )
})
