import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'

import { parseCapabilityHelp } from '../scripts/capture-capabilities.mjs'

const readJson = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
// The argv the app's plugins emitted, frozen as contract fixtures when the core took over launching
// (PLAN.md stage 6 removed the Rust that built them). The core replays the same cases byte for byte,
// so a flag here is a flag the core still passes. Cases carrying the user's `extra_args` are left
// out: those flags are the user's, not the launcher's.
const fixtureLongFlags = (set) => {
  const dir = new URL(`./fixtures/core-contracts/${set}/`, import.meta.url)
  const flags = new Set()
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name === 'index.json') continue
    const fixture = JSON.parse(readFileSync(new URL(name, dir), 'utf8'))
    if (fixture.input?.config?.extra_args) continue
    for (const arg of fixture.expected?.argv ?? [])
      if (/^--[a-z0-9][a-z0-9-]*$/.test(arg)) flags.add(arg)
  }
  assert.ok(flags.size > 0, `${set}: no flags found in the fixtures`)
  return [...flags]
}

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
  for (const flag of fixtureLongFlags('args-llamacpp')) {
    assert.ok(snapshots.turboquant.flags.includes(flag), flag)
  }
  assert.ok(snapshots.turboquant.values['--cache-type-k'].includes('turbo3'))
})

test('every upstream-emitted long flag exists in its pinned snapshot', () => {
  for (const flag of fixtureLongFlags('args')) {
    assert.ok(snapshots.upstream.flags.includes(flag), flag)
  }
  for (const value of ['draft-mtp', 'draft-dflash']) {
    assert.ok(snapshots.upstream.values['--spec-type'].includes(value))
  }
})

test('every MLX-emitted long flag exists in its pinned snapshot', () => {
  for (const flag of fixtureLongFlags('mlx-args')) {
    assert.ok(snapshots.mlx.flags.includes(flag), flag)
  }
  assert.deepEqual(snapshots.mlx.values['--draft-kind'], [
    'dflash',
    'eagle3',
    'mtp',
  ])
})
