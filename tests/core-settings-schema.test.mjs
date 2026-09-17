import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

// The web-app's "Reset to default" reads a vendored copy of atomic-chat-core's settings schema
// (web-app/src/lib/core-settings-schema/). The core copied those descriptors from the engine
// extensions, which still register them, so all three copies must stay byte-identical.
const REPO_ROOT = new URL('..', import.meta.url).pathname
const VENDORED = join(REPO_ROOT, 'web-app/src/lib/core-settings-schema')
const SCHEMAS = ['llamacpp', 'llamacpp-upstream', 'mlx']

function coreSchemaDir() {
  if (process.env.ATOMIC_CORE_SRC) {
    return join(resolve(process.env.ATOMIC_CORE_SRC), 'src/settings/schema')
  }
  const sibling = resolve(REPO_ROOT, '../atomic-chat-core/src/settings/schema')
  return existsSync(sibling) ? sibling : null
}

test('core-settings-schema CHECKSUM matches the vendored files (same algorithm as core-contracts)', () => {
  const file = join(VENDORED, 'CHECKSUM')
  assert.ok(existsSync(file), 'web-app/src/lib/core-settings-schema/CHECKSUM missing')
  const hash = createHash('sha256')
  let count = 0
  for (const name of readdirSync(VENDORED).sort()) {
    if (name === 'CHECKSUM') continue
    hash.update(name)
    hash.update(readFileSync(join(VENDORED, name)))
    count++
  }
  assert.ok(count > 0, 'no vendored files')
  assert.equal(
    hash.digest('hex'),
    readFileSync(file, 'utf8').trim(),
    'vendored core settings schema changed without recomputing CHECKSUM'
  )
})

test('every vendored schema equals the engine extension settings.json byte-for-byte', () => {
  for (const name of SCHEMAS) {
    const vendored = readFileSync(join(VENDORED, `${name}.json`))
    const extension = readFileSync(join(REPO_ROOT, `extensions/${name}-extension/settings.json`))
    assert.ok(
      vendored.equals(extension),
      `${name}: web-app/src/lib/core-settings-schema/${name}.json differs from extensions/${name}-extension/settings.json`
    )
  }
})

test('every vendored schema equals the atomic-chat-core source byte-for-byte', (t) => {
  const dir = coreSchemaDir()
  if (!dir) {
    t.skip(
      'atomic-chat-core source not found: set ATOMIC_CORE_SRC=<path to atomic-chat-core> or check it out at ../atomic-chat-core'
    )
    return
  }
  for (const name of SCHEMAS) {
    const core = join(dir, `${name}.json`)
    assert.ok(existsSync(core), `${core} missing`)
    assert.ok(
      readFileSync(join(VENDORED, `${name}.json`)).equals(readFileSync(core)),
      `${name}: vendored copy differs from ${core}; copy it again with cp and recompute CHECKSUM`
    )
  }
})
