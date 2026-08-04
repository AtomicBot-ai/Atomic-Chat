import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { parseCapabilityHelp } from '../scripts/capture-capabilities.mjs'

const readJson = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const readSource = (path) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')
const rustLongFlags = (source) =>
  [...source.matchAll(/"(--[a-z0-9][a-z0-9-]*)"\.to_string\(\)/g)].map(
    (match) => match[1]
  )

const snapshots = {
  turboquant: readJson(
    './fixtures/capabilities/turboquant-b10269-1.4.0.json'
  ),
  upstream: readJson('./fixtures/capabilities/upstream-b10205.json'),
  mlx: readJson('./fixtures/capabilities/mlx-server.json'),
}

test('capability help parser normalizes and deduplicates long flags', () => {
  const help = `usage: server [--port PORT]\n  -ctk, --cache-type-k TYPE\n  --port PORT`
  assert.deepEqual(parseCapabilityHelp(help), ['--cache-type-k', '--port'])
})

test('every TurboQuant-emitted long flag exists in its pinned snapshot', () => {
  const source = readSource(
    '../src-tauri/plugins/tauri-plugin-llamacpp/src/args.rs'
  )
  for (const flag of rustLongFlags(source)) {
    assert.ok(snapshots.turboquant.flags.includes(flag))
  }
  assert.ok(snapshots.turboquant.values['--cache-type-k'].includes('turbo3'))
})

test('every upstream-emitted long flag exists in its pinned snapshot', () => {
  const source = readSource(
    '../src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/args.rs'
  )
  for (const flag of rustLongFlags(source)) {
    assert.ok(snapshots.upstream.flags.includes(flag))
  }
  for (const value of ['draft-mtp', 'draft-dflash']) {
    assert.ok(snapshots.upstream.values['--spec-type'].includes(value))
  }
})

test('every MLX-emitted long flag exists in its pinned snapshot', () => {
  const source = readSource(
    '../src-tauri/plugins/tauri-plugin-mlx/src/commands.rs'
  )
  for (const flag of rustLongFlags(source)) {
    assert.ok(snapshots.mlx.flags.includes(flag))
  }
  assert.deepEqual(snapshots.mlx.values['--draft-kind'], [
    'dflash',
    'eagle3',
    'mtp',
  ])
})
