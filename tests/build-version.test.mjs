/**
 * Every test build a user downloads carries its own version number (tracker
 * D34, Task 27). The number is the workflow run number, stamped into the two
 * version files at build time by scripts/set-build-version.mjs — so no two
 * builds share a number, nobody bumps by hand, and merging main into a branch
 * can no longer collide a manually-committed version. This test guards that
 * contract: the writer, and the workflow wiring that uses it.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { setVersion } from '../scripts/set-build-version.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const TAURI = 'src-tauri/tauri.conf.json'
const WEB = 'web-app/package.json'

/** A scratch repo with both files, laid out like the real ones. */
function scratch(version = '2.0.37') {
  const root = mkdtempSync(path.join(tmpdir(), 'set-version-'))
  mkdirSync(path.join(root, 'src-tauri'))
  mkdirSync(path.join(root, 'web-app'))
  // The nested "version": "latest" is a plugin setting, not the app version.
  writeFileSync(
    path.join(root, TAURI),
    `{\n  "productName": "Radium",\n  "version": "${version}",\n  "plugins": {\n    "backend": {\n      "version": "latest"\n    }\n  }\n}\n`
  )
  writeFileSync(
    path.join(root, WEB),
    `{\n  "name": "@janhq/web-app",\n  "private": true,\n  "version": "${version}",\n  "type": "module"\n}\n`
  )
  return root
}

const read = (root, rel) => readFileSync(path.join(root, rel), 'utf8')

test('stamping a build sets the same version in both files', () => {
  const root = scratch('2.0.37')
  try {
    assert.equal(setVersion('2.0.204', { root }), '2.0.204')
    assert.equal(JSON.parse(read(root, TAURI)).version, '2.0.204')
    assert.equal(JSON.parse(read(root, WEB)).version, '2.0.204')
    assert.match(read(root, TAURI), /"version": "latest"/, 'the plugin setting must not change')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a run number is accepted even when it is lower than the committed value', () => {
  // Run numbers are not ordered against the placeholder in the files, so unlike
  // a manual bump, setVersion must not require the new number to be larger.
  const root = scratch('2.0.500')
  try {
    assert.equal(setVersion('2.0.12', { root }), '2.0.12')
    assert.equal(JSON.parse(read(root, WEB)).version, '2.0.12')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a malformed version is refused and leaves the files untouched', () => {
  const root = scratch('2.0.37')
  try {
    assert.throws(() => setVersion('2.0', { root }), /not a version/)
    assert.equal(JSON.parse(read(root, TAURI)).version, '2.0.37')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the installer and the app start from the same committed version', () => {
  const tauri = JSON.parse(readFileSync(path.join(repoRoot, TAURI), 'utf8')).version
  const web = JSON.parse(readFileSync(path.join(repoRoot, WEB), 'utf8')).version
  assert.equal(tauri, web, `${TAURI} says ${tauri} but ${WEB} says ${web}`)
  assert.match(tauri, /^\d+\.\d+\.\d+$/)
})

test('the Windows test build derives its version from the run number', () => {
  const workflow = readFileSync(path.join(repoRoot, '.github/workflows/windows-test-build.yml'), 'utf8')
  assert.match(
    workflow,
    /version="2\.0\.\$\{\{ github\.run_number \}\}"/,
    'the build no longer stamps a unique run-number version'
  )
  assert.match(
    workflow,
    /node scripts\/set-build-version\.mjs "\$version"/,
    'the build no longer writes the version into the project files'
  )
  assert.doesNotMatch(
    workflow,
    /git push origin "refs\/tags/,
    'the build must not push version tags any more'
  )
  assert.doesNotMatch(
    workflow,
    /contents: write/,
    'the build no longer needs write access now that it pushes no tags'
  )
  assert.match(
    workflow,
    /name: radium-windows-test-\$\{\{ steps\.version\.outputs\.version \}\}-/,
    'the installer artifact still carries its version'
  )
})
