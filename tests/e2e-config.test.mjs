// The desktop e2e build is the shipped app plus a WebDriver server, so its
// config may differ from the shipped one only where isolation demands it.
// `tauri build --config` replaces arrays wholesale, which forces
// tauri.e2e.conf.json to repeat the capability list and the main window; these
// tests fail when a copy drifts from its original.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (name) => JSON.parse(readFileSync(new URL(`../src-tauri/${name}`, import.meta.url), 'utf8'))

const base = read('tauri.conf.json')
const e2e = read('tauri.e2e.conf.json')

test('the e2e build has its own identifier, so single-instance and app-data paths never meet the real app', () => {
  assert.notEqual(e2e.identifier, base.identifier)
  assert.ok(e2e.identifier.startsWith(`${base.identifier}.`))
})

test('the e2e capabilities are the shipped ones plus exactly one inlined WebDriver capability', () => {
  const entries = e2e.app.security.capabilities
  assert.deepEqual(
    entries.filter((entry) => typeof entry === 'string'),
    base.app.security.capabilities
  )
  const inlined = entries.filter((entry) => typeof entry !== 'string')
  assert.equal(inlined.length, 1)
  assert.deepEqual(inlined[0].permissions, ['wdio-webdriver:default'])
  assert.deepEqual(inlined[0].windows, ['main'])
})

test('the e2e build tests the shipped windows: it overrides none, and isolates their WebKit store in Rust', () => {
  assert.equal(e2e.app.windows, undefined)
  // An unbundled binary shares `~/Library/WebKit/Atomic-Chat` with every dev
  // build, so a test run would rewrite the developer's webview state. A window
  // config cannot carry a data store identifier into the webview, so the e2e
  // build takes window creation over and builds the same windows itself. Both
  // halves must stay wired in, and both must stay behind the feature.
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  assert.match(lib, /#\[cfg\(feature = "e2e"\)\]\s+core::e2e::require_root\(\);/)
  assert.match(
    lib,
    /#\[cfg\(feature = "e2e"\)\]\s+let context = \{[^}]*core::e2e::take_over_windows\(&mut context\);/
  )
  assert.match(lib, /#\[cfg\(feature = "e2e"\)\]\s+\{[^}]*core::e2e::create_windows\(app\)\?;/)
  const modules = readFileSync(new URL('../src-tauri/src/core/mod.rs', import.meta.url), 'utf8')
  assert.match(modules, /#\[cfg\(feature = "e2e"\)\]\npub mod e2e;/)
})

test('the e2e build cannot reach the release update feed', () => {
  for (const endpoint of e2e.plugins.updater.endpoints) {
    assert.match(endpoint, /^https:\/\/127\.0\.0\.1:9\//)
  }
})
