import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const script = resolve(import.meta.dirname, '../scripts/download-core.mjs')

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'atomic-local-core-stamp-'))
  try {
    mkdirSync(join(root, 'scripts'))
    mkdirSync(join(root, 'src-tauri/resources/bin'), { recursive: true })
    copyFileSync(script, join(root, 'scripts/download-core.mjs'))
    // Node is a real host executable whose --version output is deterministic.
    // It exercises the copy/version-check path on Windows as well as Unix,
    // without shell-script binaries, a core build or any network access.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ atomicCore: { version: process.version } }))
    const stamp = join(root, 'src-tauri/resources/bin/atomic-chat-core-version.txt')
    const invoke = (overrides = {}) => spawnSync(process.execPath, [join(root, 'scripts/download-core.mjs')], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        SKIP_BINARIES: '',
        ATOMIC_CORE_LOCAL: process.execPath,
        ATOMIC_APP_CORE_LOCAL: process.execPath,
        ...overrides,
      },
    })
    run({ root, stamp, invoke })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('a verified local core pair creates the pinned version stamp', () => fixture(({ root, stamp, invoke }) => {
  const result = invoke()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(stamp, 'utf8'), `${process.version}\n`)
  for (const name of ['atomic-chat-core', 'atomic-chat-app-core']) {
    const output = join(root, 'src-tauri/resources/bin', process.platform === 'win32' ? `${name}.exe` : name)
    assert.ok(existsSync(output), `${name} was copied`)
  }
}))

test('a verified local core pair replaces a stale release stamp', () => fixture(({ stamp, invoke }) => {
  writeFileSync(stamp, '0.0.1\n')
  const result = invoke()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(stamp, 'utf8'), `${process.version}\n`)
}))

test('a local pair that fails version validation preserves the previous stamp', () => fixture(({ root, stamp, invoke }) => {
  writeFileSync(stamp, '0.0.1\n')
  // The CLI passes first; the second binary cannot answer --version. This
  // catches a stamp written between the two validations as well as up front.
  const invalidPartner = join(root, 'invalid-app-core')
  writeFileSync(invalidPartner, '', { mode: 0o755 })
  const result = invoke({ ATOMIC_APP_CORE_LOCAL: invalidPartner })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Bundled core version mismatch/)
  assert.equal(readFileSync(stamp, 'utf8'), '0.0.1\n')
}))

test('a missing local partner does not create a version stamp', () => fixture(({ stamp, invoke }) => {
  const result = invoke({ ATOMIC_APP_CORE_LOCAL: '' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Set ATOMIC_CORE_LOCAL and ATOMIC_APP_CORE_LOCAL together/)
  assert.equal(existsSync(stamp), false)
}))
