import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'

// Fixtures emitted by the `#[ignore]` `dump_fixtures` tests in Rust and imported
// by atomic-chat-core (`scripts/import-app-fixtures.mjs`). Both repositories keep
// the same CHECKSUM, so drift on either side is visible before a port diverges.
const ROOT = new URL('./fixtures/core-contracts/', import.meta.url).pathname
const COMPARATORS = new Set([
  'argv-exact',
  'error-exact',
  'runtime-device-exact',
  'devices-exact',
  'json-exact',
  'sse-sequence',
  'state-file-schema',
  'agent-config-files',
  'http-exchange',
  'telemetry-wire',
])

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (name !== 'CHECKSUM') yield p
  }
}

const sets = () =>
  readdirSync(ROOT)
    .filter((name) => statSync(join(ROOT, name)).isDirectory())
    .sort()

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

test('core-contracts CHECKSUM matches the fixture files (same algorithm as the core importer)', () => {
  const file = join(ROOT, 'CHECKSUM')
  assert.ok(existsSync(file), 'tests/fixtures/core-contracts/CHECKSUM missing: run the emitters, then import')
  const hash = createHash('sha256')
  let count = 0
  for (const f of walk(ROOT)) {
    hash.update(relative(ROOT, f))
    hash.update(readFileSync(f))
    count++
  }
  assert.ok(count > 0, 'no fixture files')
  assert.equal(
    hash.digest('hex'),
    readFileSync(file, 'utf8').trim(),
    'fixtures changed without re-running scripts/import-app-fixtures.mjs in atomic-chat-core'
  )
})

test('every fixture set has an index that lists exactly its case files', () => {
  for (const set of sets()) {
    const dir = join(ROOT, set)
    const index = readJson(join(dir, 'index.json'))
    assert.ok(Array.isArray(index.cases) && index.cases.length > 0, `${set}: index.cases`)
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json') && f !== 'index.json')
      .map((f) => f.slice(0, -'.json'.length))
      .sort()
    assert.deepEqual([...index.cases].sort(), files, `${set}: index.json vs files on disk`)
    assert.equal(new Set(index.cases).size, index.cases.length, `${set}: duplicate case names`)
  }
})

test('every case carries source, a known comparator, input and expected', () => {
  for (const set of sets()) {
    const dir = join(ROOT, set)
    const index = readJson(join(dir, 'index.json'))
    for (const name of index.cases) {
      const c = readJson(join(dir, `${name}.json`))
      assert.equal(c.name, name, `${set}/${name}: name`)
      assert.match(c.source?.file ?? '', /\.rs$/, `${set}/${name}: source.file`)
      assert.match(c.source?.commit ?? '', /^[0-9a-f]{7,40}$/, `${set}/${name}: source.commit`)
      assert.ok(COMPARATORS.has(c.comparator), `${set}/${name}: unknown comparator ${c.comparator}`)
      assert.ok('input' in c, `${set}/${name}: input`)
      assert.ok('expected' in c, `${set}/${name}: expected`)
      if (index.comparator) assert.equal(c.comparator, index.comparator, `${set}/${name}: comparator differs from index`)
    }
  }
})
