/**
 * The Fork features register lists everything Radium has built on top of
 * upstream, where it lives and the check that proves it still works. The
 * upstream gateway reads it (Task 25), so a row that points at files or tests
 * that no longer exist would silently report "untouched" or check nothing.
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { matchesGlob } from '../scripts/upstream-gateway.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const register = JSON.parse(
  readFileSync(path.join(repoRoot, 'docs/upstream-gateway/fork-features.json'), 'utf8')
)
const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

const STATUSES = new Set(['checked', 'no-check', 'pending'])

test('every row is complete and uniquely named', () => {
  const ids = new Set()
  for (const row of register) {
    assert.ok(row.id && !ids.has(row.id), `duplicate or missing id: ${row.id}`)
    ids.add(row.id)
    for (const field of ['feature', 'forUsers']) {
      assert.ok(typeof row[field] === 'string' && row[field].length > 0, `${row.id}: ${field}`)
    }
    assert.ok(Array.isArray(row.paths) && row.paths.length > 0, `${row.id}: paths`)
    assert.ok(Array.isArray(row.checks), `${row.id}: checks`)
    assert.ok(STATUSES.has(row.status), `${row.id}: status ${row.status}`)
    if (row.status === 'checked') assert.ok(row.checks.length > 0, `${row.id} is checked but has no check`)
    if (row.status === 'no-check') assert.equal(row.checks.length, 0, `${row.id} has checks but says no-check`)
  }
})

test('every live row points at files that exist', () => {
  for (const row of register.filter((r) => r.status !== 'pending')) {
    for (const glob of row.paths) {
      const found = tracked.some((file) => matchesGlob(glob, file))
      // A removal is protected by watching for its paths to come back.
      if (row.expectAbsent) {
        assert.equal(found, false, `${row.id}: ${glob} was meant to stay removed`)
      } else {
        assert.ok(found, `${row.id}: no tracked file matches ${glob}`)
      }
    }
    for (const check of row.checks) {
      assert.ok(typeof check.run === 'string' && check.run.length > 0, `${row.id}: check.run`)
      for (const file of check.files ?? []) {
        assert.ok(existsSync(path.join(repoRoot, file)), `${row.id}: check file ${file} is missing`)
      }
    }
  }
})

test('the gaps are listed, not hidden', () => {
  const gaps = register.filter((row) => row.status === 'no-check').map((row) => row.id)
  // Not a failure: the register is honest about features nothing protects yet.
  // T25-S03 closes these one by one.
  if (gaps.length) console.log(`features with no check yet: ${gaps.join(', ')}`)
  assert.ok(register.length >= 10, 'the register should cover the fork, not a sample')
})
