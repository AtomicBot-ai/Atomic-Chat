/**
 * Every build of Radium handed to the user carries a new version number
 * (the user's standing rule, 2026-09-14; tracker D34, Task 27). Until then every
 * test build said 2.0.37, so installers could not be told apart and the app's
 * version-triggered extension reinstall never ran.
 *
 * The version lives in two files that must always agree:
 * src-tauri/tauri.conf.json (the installer and Windows) and web-app/package.json
 * (the "v2.0.xx" shown in the sidebar). scripts/bump-version.mjs changes both.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { bumpVersion, readVersions } from '../scripts/bump-version.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(repoRoot, 'scripts', 'bump-version.mjs')

const TAURI = 'src-tauri/tauri.conf.json'
const WEB = 'web-app/package.json'

/** A scratch repo with both files, laid out like the real ones. */
function scratch(tauriVersion = '2.0.37', webVersion = tauriVersion) {
  const root = mkdtempSync(path.join(tmpdir(), 'version-'))
  mkdirSync(path.join(root, 'src-tauri'))
  mkdirSync(path.join(root, 'web-app'))
  // The nested "version": "latest" is a plugin setting, not the app version.
  writeFileSync(
    path.join(root, TAURI),
    `{\n  "productName": "Radium",\n  "version": "${tauriVersion}",\n  "plugins": {\n    "backend": {\n      "version": "latest"\n    }\n  }\n}\n`
  )
  writeFileSync(
    path.join(root, WEB),
    `{\n  "name": "@janhq/web-app",\n  "private": true,\n  "version": "${webVersion}",\n  "type": "module"\n}\n`
  )
  return root
}

const read = (root, rel) => readFileSync(path.join(root, rel), 'utf8')

test('the installer and the app show the same version', () => {
  const { tauri, web } = readVersions(repoRoot)
  assert.equal(tauri, web, `${TAURI} says ${tauri} but ${WEB} says ${web}`)
  assert.match(tauri, /^\d+\.\d+\.\d+$/)
})

test('a bump adds one to the last number in both files, and nothing else', () => {
  const root = scratch('2.0.37')
  try {
    assert.equal(bumpVersion({ root }), '2.0.38')
    assert.deepEqual(readVersions(root), { tauri: '2.0.38', web: '2.0.38' })
    assert.match(read(root, TAURI), /"version": "latest"/, 'the plugin setting must not change')
    assert.equal(
      read(root, WEB),
      '{\n  "name": "@janhq/web-app",\n  "private": true,\n  "version": "2.0.38",\n  "type": "module"\n}\n',
      'formatting is kept'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an explicit version is set in both files, and a malformed one is refused', () => {
  const root = scratch('2.0.37')
  try {
    assert.equal(bumpVersion({ root, to: '3.0.1' }), '3.0.1')
    assert.deepEqual(readVersions(root), { tauri: '3.0.1', web: '3.0.1' })
    assert.throws(() => bumpVersion({ root, to: '3.0' }), /x\.y\.z/)
    // The Windows installer cannot take a version that goes backwards.
    assert.throws(() => bumpVersion({ root, to: '2.0.40' }), /not newer/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a bump refuses to guess when the two files already disagree', () => {
  const root = scratch('2.0.37', '2.0.39')
  try {
    assert.throws(() => bumpVersion({ root }), /disagree/)
    assert.deepEqual(readVersions(root), { tauri: '2.0.37', web: '2.0.39' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the command prints the new version', () => {
  const root = scratch('2.0.41')
  try {
    const result = spawnSync(process.execPath, [cli, '--root', root], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), '2.0.42')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
