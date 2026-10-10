import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  installArchive,
  isCurrent,
  mlxAssetUrl,
  parseMlxManifest,
} from '../scripts/fetch-mlx-server.mjs'

const TAG = 'mlxvlm-macos-arm64-07ba5a1'
const NAME = 'mlxvlm-mlx-server-macos-arm64.tar.gz'

function work() {
  return mkdtempSync(join(tmpdir(), 'mlx-server-fetch-'))
}

/** The release archive: one `mlx-server` at the top, as the fork's CI packs it. */
function archive(dir, body = '#!/bin/sh\necho mlx-server\n') {
  const src = join(dir, 'src')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'mlx-server'), body, { mode: 0o755 })
  const path = join(dir, NAME)
  execFileSync('tar', ['-czf', path, '-C', src, 'mlx-server'])
  const bytes = readFileSync(path)
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
}

function manifest(overrides = {}, asset = {}) {
  return {
    $schema: './mlx-schema.json',
    upstream_repo: 'AtomicBot-ai/mlx-vlm',
    tag_name: TAG,
    published_at: '2026-08-28T10:38:38Z',
    assets: [
      { backend: 'macos-arm64', name: NAME, sha256: 'a'.repeat(64), size: 1, ...asset },
    ],
    ...overrides,
  }
}

test('reads the tag, the date and the one macOS archive from the conf manifest', () => {
  const parsed = parseMlxManifest(manifest())
  assert.deepEqual(parsed, {
    upstream_repo: 'AtomicBot-ai/mlx-vlm',
    tag: TAG,
    published_at: '2026-08-28T10:38:38Z',
    asset: { name: NAME, sha256: 'a'.repeat(64), size: 1 },
  })
  assert.equal(
    mlxAssetUrl(parsed),
    `https://github.com/AtomicBot-ai/mlx-vlm/releases/download/${TAG}/${NAME}`
  )
})

test('refuses a manifest that does not pin one build', () => {
  assert.throws(() => parseMlxManifest(manifest({ tag_name: 'latest' })), /tag_name/)
  assert.throws(() => parseMlxManifest(manifest({}, { sha256: undefined })), /sha256/)
  assert.throws(() => parseMlxManifest(manifest({}, { size: 0 })), /size/)
  assert.throws(() => parseMlxManifest(manifest({ published_at: 'yesterday' })), /published_at/)
  assert.throws(() => parseMlxManifest(manifest({ assets: [] })), /one macos-arm64/)
})

test('installs the verified binary with its metadata and drops the old version files', () => {
  const dir = work()
  try {
    const built = archive(dir)
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'mlx-server-version.txt'), 'old\n')
    writeFileSync(join(bin, 'mlx-server-backend.txt'), 'macos-arm64\n')
    const parsed = parseMlxManifest(manifest({}, { sha256: built.sha256, size: built.size }))

    installArchive({ archivePath: built.path, binDir: bin, manifest: parsed })

    assert.match(readFileSync(join(bin, 'mlx-server'), 'utf8'), /echo mlx-server/)
    assert.deepEqual(JSON.parse(readFileSync(join(bin, 'mlx-server.json'), 'utf8')), {
      tag: TAG,
      published_at: '2026-08-28T10:38:38Z',
    })
    assert.equal(existsSync(join(bin, 'mlx-server-version.txt')), false)
    assert.equal(existsSync(join(bin, 'mlx-server-backend.txt')), false)
    assert.deepEqual(readdirSync(bin).sort(), ['mlx-server', 'mlx-server.json'])
    assert.equal(isCurrent(bin, parsed), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a substituted archive fails before anything lands in the bin directory', () => {
  const dir = work()
  try {
    const built = archive(dir, '#!/bin/sh\necho substituted\n')
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'mlx-server.json'), '{"tag":"before"}')
    const parsed = parseMlxManifest(manifest({}, { sha256: 'b'.repeat(64), size: built.size }))

    assert.throws(
      () => installArchive({ archivePath: built.path, binDir: bin, manifest: parsed }),
      /sha256/
    )
    assert.deepEqual(readdirSync(bin), ['mlx-server.json'])
    assert.equal(readFileSync(join(bin, 'mlx-server.json'), 'utf8'), '{"tag":"before"}')

    const wrongSize = parseMlxManifest(manifest({}, { sha256: built.sha256, size: built.size + 1 }))
    assert.throws(
      () => installArchive({ archivePath: built.path, binDir: bin, manifest: wrongSize }),
      /size/
    )
    assert.deepEqual(readdirSync(bin), ['mlx-server.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('is current only for the manifest tag with the binary present', () => {
  const dir = work()
  try {
    const parsed = parseMlxManifest(manifest())
    assert.equal(isCurrent(dir, parsed), false)
    writeFileSync(join(dir, 'mlx-server.json'), JSON.stringify({ tag: TAG }))
    assert.equal(isCurrent(dir, parsed), false)
    writeFileSync(join(dir, 'mlx-server'), '')
    assert.equal(isCurrent(dir, parsed), true)
    writeFileSync(join(dir, 'mlx-server.json'), JSON.stringify({ tag: 'mlxvlm-macos-arm64-0000000' }))
    assert.equal(isCurrent(dir, parsed), false)
    writeFileSync(join(dir, 'mlx-server.json'), 'not json')
    assert.equal(isCurrent(dir, parsed), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
