import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

function fixture(appVersion = '0.22.0') {
  const root = mkdtempSync(join(tmpdir(), 'atomic-local-core-'))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'src-tauri/resources/bin'), { recursive: true })
  copyFileSync(new URL('../scripts/download-core.mjs', import.meta.url), join(root, 'scripts/download-core.mjs'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ atomicCore: { version: '0.21.4' } }))
  const paths = ['cli', 'app'].map((name, index) => {
    const path = join(root, name)
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${index ? appVersion : '0.22.0'}'\n`, { mode: 0o755 })
    return path
  })
  return { root, paths }
}

function install({ root, paths }) {
  return spawnSync(process.execPath, [join(root, 'scripts/download-core.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, SKIP_BINARIES: '', ATOMIC_CORE_VERSION: '0.22.0', ATOMIC_CORE_LOCAL: paths[0], ATOMIC_APP_CORE_LOCAL: paths[1] },
  })
}

test('an explicit development version installs the local pair without changing the release pin', { skip: process.platform === 'win32' }, () => {
  const f = fixture()
  const result = install(f)
  assert.equal(result.status, 0, result.stderr)
  for (const name of ['atomic-chat-core', 'atomic-chat-app-core']) {
    assert.equal(spawnSync(join(f.root, 'src-tauri/resources/bin', name), ['--version'], { encoding: 'utf8' }).stdout.trim(), '0.22.0')
  }
  assert.equal(JSON.parse(readFileSync(join(f.root, 'package.json'))).atomicCore.version, '0.21.4')
})

test('a mismatched local pair is refused before either installed binary changes', { skip: process.platform === 'win32' }, () => {
  const f = fixture('0.23.0')
  for (const name of ['atomic-chat-core', 'atomic-chat-app-core']) writeFileSync(join(f.root, 'src-tauri/resources/bin', name), 'previous')
  const result = install(f)
  assert.notEqual(result.status, 0)
  for (const name of ['atomic-chat-core', 'atomic-chat-app-core']) assert.equal(readFileSync(join(f.root, 'src-tauri/resources/bin', name), 'utf8'), 'previous')
})
