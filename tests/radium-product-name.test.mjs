/**
 * The installed product is "Radium", and renaming it must never strand an
 * existing "Atomic Chat" install: not its data, its program files, its MSI
 * upgrade path, nor its launch-at-startup entry. These pin the parts of that
 * change a later edit could quietly undo.
 *
 * See docs/decisions/2026-09-13-rename-the-product-to-radium-and-move-the-data-folder.md.
 */
import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8')

test('the product is Radium and the identifier keeps its old value', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'))
  assert.equal(config.productName, 'Radium')
  assert.equal(
    config.identifier,
    'chat.atomic.app',
    'WebView2 storage and the MSI upgrade live under the identifier; renaming it needs its own migration'
  )
})

test('the main window is titled Radium', () => {
  const windows = JSON.parse(read('src-tauri/tauri.windows.conf.json'))
  assert.equal(windows.app?.windows?.[0]?.title, 'Radium')
})

test('no translation still calls the product Radium Chat or Atomic Chat', () => {
  const localesDir = path.join(repoRoot, 'web-app/src/locales')
  const offenders = []
  for (const locale of readdirSync(localesDir)) {
    for (const file of readdirSync(path.join(localesDir, locale))) {
      const text = read(`web-app/src/locales/${locale}/${file}`)
      for (const old of ['Radium Chat', 'Atomic Chat']) {
        if (text.includes(old)) offenders.push(`${locale}/${file}: "${old}"`)
      }
    }
  }
  assert.deepEqual(offenders, [], 'rename these strings to "Radium"')
})

test('the MSI upgrade code stays pinned, so MSI installs keep upgrading in place', () => {
  const windows = JSON.parse(read('src-tauri/tauri.windows.conf.json'))
  assert.equal(
    windows.bundle?.windows?.wix?.upgradeCode,
    'b75dd42f-800c-57cb-8c5c-ed7fcbef13a0'
  )
})

test('the installer removes an Atomic Chat install before installing', () => {
  const hooks = read('src-tauri/windows/hooks.nsh')
  assert.ok(
    hooks.includes('!macro NSIS_HOOK_PREINSTALL'),
    'no pre-install hook'
  )
  assert.ok(
    hooks.includes('Uninstall\\Atomic Chat'),
    'the pre-install hook does not look for an NSIS "Atomic Chat" install'
  )
  assert.ok(
    hooks.includes('StrCmp $R9 "Atomic Chat"') && hooks.includes('msiexec /x'),
    'the pre-install hook does not remove an MSI "Atomic Chat" install'
  )
})

test('the uninstaller cleans the data folder under every name it has had', () => {
  const hooks = read('src-tauri/windows/hooks.nsh')
  for (const name of ['Radium', 'Radium Chat', 'Atomic Chat']) {
    assert.ok(
      hooks.includes(`RmDir /r "$APPDATA\\${name}"`),
      `the uninstaller does not clean %APPDATA%\\${name}`
    )
  }
})

test('the data folder is moved before setup resolves it for anything', () => {
  const lib = read('src-tauri/src/lib.rs')
  const setup = lib.indexOf('.setup(|app| {')
  assert.ok(setup >= 0, 'setup closure not found')
  const migration = lib.indexOf('migrate_default_data_folder(', setup)
  const firstUse = lib.indexOf('get_jan_data_folder_path(', setup)
  assert.ok(migration > setup, 'setup does not run the data folder migration')
  assert.ok(
    migration < firstUse,
    'the data folder is resolved before it has been moved'
  )
})

test('the legacy launch-at-startup migration is registered for the app', () => {
  const lib = read('src-tauri/src/lib.rs')
  const registrations =
    lib.split('core::system::commands::migrate_legacy_autostart_entry,')
      .length - 1
  assert.equal(
    registrations,
    2,
    'register migrate_legacy_autostart_entry in both invoke handler lists'
  )
})
