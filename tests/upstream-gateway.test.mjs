/**
 * The upstream update gateway (Task 25, D31 = A).
 *
 * Before any upstream sync, a trial merge reports which Radium features the
 * update touches and how; the user decides each flagged row; the gate refuses
 * the merge until every flagged row has a decision; after the merge every
 * feature's check runs. These tests drive it against a small throwaway repo
 * whose "upstream" edits, conflicts with and deletes files that fake features
 * live in.
 */
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  buildImpactReport,
  checkGate,
  matchesGlob,
  runChecks,
} from '../scripts/upstream-gateway.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(repoRoot, 'scripts', 'upstream-gateway.mjs')

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function commitAll(dir, message) {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}

/** base -> fork edits a.txt; upstream edits a.txt (same line), b.txt, deletes c.txt. */
function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gateway-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'user.name', 'Gateway Test')
  git(dir, 'config', 'core.autocrlf', 'false')
  for (const name of ['a', 'b', 'c', 'd']) {
    writeFileSync(path.join(dir, `${name}.txt`), `${name} one\n${name} two\n`)
  }
  commitAll(dir, 'base')
  git(dir, 'branch', 'upstream')

  writeFileSync(path.join(dir, 'a.txt'), 'a one\na two - fork\n')
  commitAll(dir, 'fork: change a')

  git(dir, 'switch', '-q', 'upstream')
  writeFileSync(path.join(dir, 'a.txt'), 'a one\na two - upstream\n')
  commitAll(dir, 'upstream: change a')
  writeFileSync(path.join(dir, 'b.txt'), 'b one\nb two - upstream\n')
  unlinkSync(path.join(dir, 'c.txt'))
  commitAll(dir, 'upstream: change b, delete c')
  git(dir, 'switch', '-q', 'main')
  return dir
}

const register = [
  { id: 'conflicting', feature: 'Feature A', forUsers: 'A', paths: ['a.txt'], checks: [] },
  { id: 'edited', feature: 'Feature B', forUsers: 'B', paths: ['*.txt'], checks: [] },
  { id: 'deleted', feature: 'Feature C', forUsers: 'C', paths: ['c.txt'], checks: [] },
  { id: 'untouched', feature: 'Feature D', forUsers: 'D', paths: ['d.txt'], checks: [] },
]

const rowById = (report, id) => report.rows.find((row) => row.id === id)

test('matches paths the way the register writes them', () => {
  assert.equal(matchesGlob('web-app/src/**', 'web-app/src/a/b.ts'), true)
  assert.equal(matchesGlob('web-app/src/**', 'web-app/srcx/b.ts'), false)
  assert.equal(matchesGlob('*.md', 'README.md'), true)
  assert.equal(matchesGlob('*.md', 'docs/x.md'), false)
  assert.equal(matchesGlob('src-tauri/tauri.conf.json', 'src-tauri/tauri.conf.json'), true)
  assert.equal(matchesGlob('web-app/src/routes/settings/*.tsx', 'web-app/src/routes/settings/api.tsx'), true)
})

test('reports what upstream would do to each feature, without touching the branch', () => {
  const dir = makeRepo()
  try {
    const headBefore = git(dir, 'rev-parse', 'HEAD')
    const report = buildImpactReport({ root: dir, base: 'main', upstream: 'upstream', register })

    assert.equal(report.upstreamHead, git(dir, 'rev-parse', 'upstream'))
    assert.equal(rowById(report, 'conflicting').kind, 'conflict')
    assert.equal(rowById(report, 'conflicting').recommendation, 'adapt')
    assert.deepEqual(
      rowById(report, 'conflicting').commits.map((c) => c.subject),
      ['upstream: change a']
    )
    // The widest kind wins: b is edited, a conflicts, c is deleted.
    assert.equal(rowById(report, 'edited').kind, 'conflict')
    assert.equal(rowById(report, 'deleted').kind, 'deleted')
    assert.equal(rowById(report, 'untouched').kind, 'untouched')
    assert.equal(rowById(report, 'untouched').flagged, false)
    assert.deepEqual(report.unownedConflicts, [])
    for (const id of ['conflicting', 'edited', 'deleted']) {
      assert.equal(rowById(report, id).flagged, true, id)
      assert.ok(rowById(report, id).consequence.length > 20, id)
      assert.equal(rowById(report, id).decision, null, id)
    }

    assert.equal(git(dir, 'rev-parse', 'HEAD'), headBefore)
    assert.equal(git(dir, 'status', '--porcelain'), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('names a plain upstream edit as an edit', () => {
  const dir = makeRepo()
  try {
    const report = buildImpactReport({
      root: dir,
      base: 'main',
      upstream: 'upstream',
      register: [{ id: 'b-only', feature: 'B', forUsers: 'B', paths: ['b.txt'], checks: [] }],
    })
    assert.equal(report.rows[0].kind, 'edited')
    assert.equal(report.rows[0].recommendation, 'take-theirs')
    // A conflict in a file no feature claims is still named: the window
    // controls were lost in exactly such a file.
    assert.deepEqual(report.unownedConflicts, ['a.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('keeps a decision only while the upstream changes it was made on are unchanged', () => {
  const dir = makeRepo()
  try {
    const first = buildImpactReport({ root: dir, base: 'main', upstream: 'upstream', register })
    rowById(first, 'deleted').decision = 'keep-ours'
    rowById(first, 'deleted').decidedOn = '2026-09-13'

    const again = buildImpactReport({ root: dir, base: 'main', upstream: 'upstream', register, previous: first })
    assert.equal(rowById(again, 'deleted').decision, 'keep-ours')
    assert.equal(rowById(again, 'deleted').decidedOn, '2026-09-13')

    git(dir, 'switch', '-q', 'upstream')
    writeFileSync(path.join(dir, 'c.txt'), 'c is back\n')
    commitAll(dir, 'upstream: restore c')
    git(dir, 'switch', '-q', 'main')

    const moved = buildImpactReport({ root: dir, base: 'main', upstream: 'upstream', register, previous: first })
    assert.equal(rowById(moved, 'deleted').decision, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the gate refuses until every flagged row has a real decision', () => {
  const report = {
    upstreamHead: 'abc',
    rows: [
      { id: 'one', flagged: true, decision: null },
      { id: 'two', flagged: true, decision: 'maybe' },
      { id: 'three', flagged: true, decision: 'adapt' },
      { id: 'four', flagged: false, decision: null },
    ],
  }
  assert.deepEqual(checkGate(report, { upstreamHead: 'abc' }), {
    ok: false,
    stale: false,
    undecided: ['one', 'two'],
  })

  report.rows[0].decision = 'keep-ours'
  report.rows[1].decision = 'take-theirs'
  assert.deepEqual(checkGate(report, { upstreamHead: 'abc' }), { ok: true, stale: false, undecided: [] })

  // A report made for an older upstream says nothing about the new one.
  assert.equal(checkGate(report, { upstreamHead: 'def' }).ok, false)
  assert.equal(checkGate(report, { upstreamHead: 'def' }).stale, true)
})

test('the gate command exits non-zero naming the undecided rows, then passes', () => {
  const dir = makeRepo()
  try {
    const reportPath = path.join(dir, 'impact.json')
    const impact = spawnSync(process.execPath, [cli, 'impact', '--root', dir, '--base', 'main', '--upstream', 'upstream', '--register', path.join(dir, 'register.json'), '--out', reportPath], { encoding: 'utf8' })
    assert.notEqual(impact.status, 0, 'impact must fail without a register')

    writeFileSync(path.join(dir, 'register.json'), JSON.stringify(register))
    const ok = spawnSync(process.execPath, [cli, 'impact', '--root', dir, '--base', 'main', '--upstream', 'upstream', '--register', path.join(dir, 'register.json'), '--out', reportPath], { encoding: 'utf8' })
    assert.equal(ok.status, 0, ok.stderr)

    const gateArgs = [cli, 'gate', '--root', dir, '--upstream', 'upstream', '--report', reportPath]
    const refused = spawnSync(process.execPath, gateArgs, { encoding: 'utf8' })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /conflicting/)
    assert.match(refused.stderr, /deleted/)
    assert.doesNotMatch(refused.stderr, /untouched/)

    const decided = JSON.parse(readFileSync(reportPath, 'utf8'))
    for (const row of decided.rows) if (row.flagged) row.decision = 'adapt'
    writeFileSync(reportPath, JSON.stringify(decided))
    const passed = spawnSync(process.execPath, gateArgs, { encoding: 'utf8' })
    assert.equal(passed.status, 0, passed.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('after a merge, every feature check runs and a failing one is named', () => {
  const failures = runChecks(
    [
      { id: 'good', checks: [{ run: `"${process.execPath}" -e ""` }] },
      { id: 'bad', checks: [{ run: `"${process.execPath}" -e "process.exit(3)"` }] },
      { id: 'gap', checks: [] },
    ],
    { root: repoRoot, quiet: true }
  )
  assert.deepEqual(
    failures.map((f) => f.id),
    ['bad']
  )
})
