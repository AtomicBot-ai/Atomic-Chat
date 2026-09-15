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
import { readdirSync, readFileSync, statSync } from 'node:fs'
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

/**
 * The user (2026-09-14): Minimize, Maximize and Close "isnt working on some
 * pages. It works fine on the main page but not every page." Anything drawn
 * above the strip swallows clicks on those buttons: notifications sit at the
 * top right (sonner's toaster uses z-index 999999999), and full-screen viewers
 * and drop-downs use z-index 100 and 9999. The strip must sit above all of it.
 */
test('the window buttons sit above everything the app can draw over them', () => {
  const frame = read('web-app/src/components/WindowFrame.tsx')
  const strip = /className="[^"]*absolute inset-x-0 top-0 z-\[(\d+)\][^"]*h-8/.exec(frame)
  assert.ok(strip, 'the strip has no explicit z-index')
  const stripZ = Number(strip[1])

  const SONNER_TOASTER_Z = 999999999
  let highest = { z: SONNER_TOASTER_Z, where: 'sonner toaster' }
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = `${dir}/${name}`
      if (statSync(path).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue
        walk(path)
      } else if (/\.(tsx?|css)$/.test(name) && !/\.test\./.test(name)) {
        if (path.endsWith('components/WindowFrame.tsx')) continue
        // Print-only rules are left out: while a document prints, the print
        // region covers everything on purpose and nothing can be clicked.
        const source = readFileSync(path, 'utf8').replace(
          /[^{}]*body\.artifact-printing[^{}]*\{[^}]*\}/g,
          ''
        )
        for (const m of source.matchAll(/\bz-\[?(\d+)\]?|z-index\s*:\s*(\d+)|zIndex\s*:\s*(\d+)/g)) {
          const z = Number(m[1] ?? m[2] ?? m[3])
          if (z > highest.z) highest = { z, where: path }
        }
      }
    }
  }
  walk(path.join(repoRoot, 'web-app/src'))
  assert.ok(
    stripZ > highest.z,
    `the strip (z-index ${stripZ}) is below ${highest.where} (z-index ${highest.z})`
  )
})

/**
 * The same report, second cause: an open pop-up or drop-down menu sets
 * `pointer-events: none` on <body> (Radix modal layers), and the strip inherits
 * it. The strip has to switch clicks back on for itself.
 * web-app/src/components/__tests__/WindowFrame.test.tsx clicks the buttons
 * with a pop-up open.
 */
test('the window buttons still take clicks while a pop-up or menu is open', () => {
  const frame = read('web-app/src/components/WindowFrame.tsx')
  assert.match(
    frame,
    /z-\[\d+\] h-8[^"]*"\s*style=\{\{\s*pointerEvents:\s*'auto'\s*\}\}/,
    'the window strip no longer sets pointer-events: auto for itself'
  )
})
