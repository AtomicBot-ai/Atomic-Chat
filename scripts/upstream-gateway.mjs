#!/usr/bin/env node
/**
 * Upstream update gateway (Task 25, decision D31 = A).
 *
 * Nothing from upstream is merged blind. Before a sync:
 *
 *   impact      Trial-merges upstream in memory (`git merge-tree`, which never
 *               touches the working tree or any branch) and, for every row of
 *               the Fork features register, reports what upstream would do to
 *               it: untouched, edited, deleted or conflicting, with the commits
 *               and a plain-language consequence. Written as JSON (read by the
 *               gate) and Markdown (read by people). Decisions already made
 *               are kept while the upstream changes they were made on are
 *               unchanged.
 *   gate        Exits non-zero while any flagged row has no decision
 *               (keep-ours, take-theirs or adapt), or while the report was made
 *               for an older upstream than the one about to be merged.
 *   post-merge  After the merge, runs every feature's checks and names the
 *               ones that fail.
 *
 * Usage: node scripts/upstream-gateway.mjs <impact|gate|post-merge> [--root .]
 *        [--base HEAD] [--upstream upstream/main]
 *        [--register docs/upstream-gateway/fork-features.json]
 *        [--out|--report docs/upstream-gateway/upstream-impact.json]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DECISIONS = ['keep-ours', 'take-theirs', 'adapt']
const KIND_RANK = { untouched: 0, edited: 1, deleted: 2, conflict: 3 }

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_REGISTER = 'docs/upstream-gateway/fork-features.json'
const DEFAULT_REPORT = 'docs/upstream-gateway/upstream-impact.json'

/** `*` stays inside one path segment, `**` crosses segments, `?` is one character. */
export function matchesGlob(glob, file) {
  let pattern = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*' && glob[index + 1] === '*') {
      index += 1
      if (glob[index + 1] === '/') {
        index += 1
        pattern += '(?:.*/)?'
      } else {
        pattern += '.*'
      }
    } else if (char === '*') {
      pattern += '[^/]*'
    } else if (char === '?') {
      pattern += '[^/]'
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${pattern}$`).test(file)
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }).trim()
}

/** Net effect of upstream since the merge base: path -> 'edited' | 'deleted'. */
function upstreamChanges(root, mergeBase, upstreamHead) {
  const changes = new Map()
  const output = git(root, ['diff', '--name-status', '-M', mergeBase, upstreamHead])
  for (const line of output.split('\n').filter(Boolean)) {
    const [status, first, second] = line.split('\t')
    if (status.startsWith('R')) {
      changes.set(first, 'deleted')
      changes.set(second, 'edited')
    } else {
      changes.set(first, status === 'D' ? 'deleted' : 'edited')
    }
  }
  return changes
}

function upstreamCommits(root, mergeBase, upstreamHead) {
  const output = git(root, [
    'log',
    '--format=%x1e%H%x1f%ad%x1f%s',
    '--date=short',
    '--name-only',
    `${mergeBase}..${upstreamHead}`,
  ])
  return output
    .split('\x1e')
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const [header, ...files] = chunk.split('\n')
      const [sha, date, subject] = header.split('\x1f')
      return { sha, date, subject, files: files.map((f) => f.trim()).filter(Boolean) }
    })
}

/** Files a real merge would stop on. Writes objects only - no ref or file changes. */
function trialMergeConflicts(root, baseHead, upstreamHead) {
  const result = spawnSync(
    'git',
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', baseHead, upstreamHead],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  )
  if (result.status === 0) return []
  if (result.status === 1) {
    return result.stdout
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
  }
  throw new Error(`git merge-tree failed: ${result.stderr || result.error}`)
}

function listFiles(files) {
  const names = files.map((file) => file.path)
  const shown = names.slice(0, 3).join(', ')
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown
}

function consequenceFor(feature, kind, files) {
  const name = `"${feature.feature}"`
  if (kind === 'untouched') return "Upstream does not touch this feature's files."
  if (feature.expectAbsent) {
    return `Upstream brings back ${listFiles(files)} - code Radium removed on purpose. Taking it would undo that removal.`
  }
  const conflicting = files.filter((file) => file.kind === 'conflict')
  if (kind === 'conflict') {
    return `Upstream changed the same lines Radium changed in ${listFiles(conflicting)}. The merge cannot finish on its own: someone must choose Radium's version, upstream's, or combine them, and a careless choice can break ${name}.`
  }
  const deleted = files.filter((file) => file.kind === 'deleted')
  if (kind === 'deleted') {
    return `Upstream deletes or moves ${listFiles(deleted)}, which ${name} needs. Taking the update as it is would remove or break this feature.`
  }
  return `Upstream edits ${listFiles(files)}, where ${name} lives. The merge applies cleanly, but the feature's checks must pass afterwards to prove it still works.`
}

function recommendationFor(feature, kind) {
  if (kind === 'untouched') return null
  if (feature.expectAbsent) return 'keep-ours'
  return kind === 'edited' ? 'take-theirs' : 'adapt'
}

const shaList = (commits) => (commits ?? []).map((commit) => commit.sha).join(',')

export function buildImpactReport({
  root,
  base = 'HEAD',
  upstream = 'upstream/main',
  register,
  previous = null,
  now = new Date(),
}) {
  const baseHead = git(root, ['rev-parse', base])
  const upstreamHead = git(root, ['rev-parse', upstream])
  const mergeBase = git(root, ['merge-base', baseHead, upstreamHead])
  const changes = upstreamChanges(root, mergeBase, upstreamHead)
  const commits = upstreamCommits(root, mergeBase, upstreamHead)
  const conflicts = new Set(trialMergeConflicts(root, baseHead, upstreamHead))
  const previousRows = new Map((previous?.rows ?? []).map((row) => [row.id, row]))

  const rows = register.map((feature) => {
    const matches = (file) => feature.paths.some((glob) => matchesGlob(glob, file))
    const files = []
    for (const [file, change] of changes) {
      if (matches(file)) files.push({ path: file, kind: conflicts.has(file) ? 'conflict' : change })
    }
    for (const file of conflicts) {
      if (matches(file) && !changes.has(file)) files.push({ path: file, kind: 'conflict' })
    }
    files.sort((a, b) => a.path.localeCompare(b.path))

    const kind = files.reduce(
      (widest, file) => (KIND_RANK[file.kind] > KIND_RANK[widest] ? file.kind : widest),
      'untouched'
    )
    const flagged = kind !== 'untouched'
    const featureCommits = commits
      .filter((commit) => commit.files.some(matches))
      .map(({ sha, date, subject }) => ({ sha, date, subject }))

    const before = previousRows.get(feature.id)
    const decisionStillApplies =
      flagged &&
      before &&
      DECISIONS.includes(before.decision) &&
      shaList(before.commits) === shaList(featureCommits)

    return {
      id: feature.id,
      feature: feature.feature,
      forUsers: feature.forUsers,
      status: feature.status ?? null,
      kind,
      flagged,
      files,
      commits: featureCommits,
      checks: feature.checks ?? [],
      consequence: consequenceFor(feature, kind, files),
      recommendation: recommendationFor(feature, kind),
      decision: decisionStillApplies ? before.decision : null,
      decidedOn: decisionStillApplies ? before.decidedOn ?? null : null,
    }
  })

  // Conflicts in files no feature claims still have to be resolved by hand,
  // and a silent loss hides there: the window controls went in `__root.tsx`
  // before any feature row watched it.
  const unownedConflicts = [...conflicts]
    .filter((file) => !register.some((feature) => feature.paths.some((glob) => matchesGlob(glob, file))))
    .sort()

  return {
    generatedAt: now.toISOString(),
    base,
    baseHead,
    upstream,
    upstreamHead,
    mergeBase,
    upstreamCommitCount: commits.length,
    conflictCount: conflicts.size,
    unownedConflicts,
    rows,
  }
}

export function checkGate(report, { upstreamHead }) {
  const stale = report.upstreamHead !== upstreamHead
  const undecided = report.rows
    .filter((row) => row.flagged && !DECISIONS.includes(row.decision))
    .map((row) => row.id)
  return { ok: !stale && undecided.length === 0, stale, undecided }
}

export function runChecks(register, { root, quiet = false }) {
  const failures = []
  for (const feature of register) {
    if (feature.status === 'pending') continue
    for (const check of feature.checks ?? []) {
      if (!quiet) console.log(`\n[${feature.id}] ${check.run}`)
      const result = spawnSync(check.run, {
        cwd: path.join(root, check.cwd ?? '.'),
        shell: true,
        stdio: quiet ? 'pipe' : 'inherit',
        env: { ...process.env, ...(check.env ?? {}) },
      })
      if (result.status !== 0) {
        failures.push({ id: feature.id, run: check.run, status: result.status })
      }
    }
  }
  return failures
}

export function renderMarkdown(report) {
  const lines = [
    '# Upstream impact',
    '',
    `Made ${report.generatedAt} for \`${report.upstream}\` at \`${report.upstreamHead.slice(0, 9)}\` against \`${report.base}\` at \`${report.baseHead.slice(0, 9)}\`.`,
    `${report.upstreamCommitCount} upstream commits since the last sync; ${report.conflictCount} files would conflict.`,
    '',
    'Every flagged row needs a decision before the merge: **keep-ours**, **take-theirs** or **adapt**.',
    'Record it in the tracker\'s Upstream impact sheet (or the JSON next to this file); `make upstream-gate` refuses until all are made.',
    '',
  ]
  const flagged = report.rows.filter((row) => row.flagged)
  if (flagged.length === 0) lines.push('Upstream touches none of Radium\'s features.', '')
  for (const row of flagged) {
    lines.push(
      `## ${row.feature} - ${row.kind}`,
      '',
      row.consequence,
      '',
      `- Recommendation: **${row.recommendation}**`,
      `- Decision: ${row.decision ? `**${row.decision}** (${row.decidedOn ?? 'date not recorded'})` : '_not decided_'}`,
      `- Files: ${row.files.map((file) => `\`${file.path}\` (${file.kind})`).join(', ')}`,
      `- Upstream commits: ${row.commits.map((commit) => `${commit.sha.slice(0, 9)} ${commit.subject}`).join('; ') || 'none listed'}`,
      ''
    )
  }
  if (report.unownedConflicts?.length) {
    lines.push(
      '## Conflicts in files no feature claims',
      '',
      'These stop the merge too. Check whether any of them carries something Radium built; if so, add it to the register first.',
      '',
      ...report.unownedConflicts.map((file) => `- \`${file}\``),
      ''
    )
  }
  const untouched = report.rows.filter((row) => !row.flagged).map((row) => row.feature)
  if (untouched.length) lines.push(`Untouched: ${untouched.join(', ')}.`, '')
  return lines.join('\n')
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = { command }
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (!flag.startsWith('--') || value === undefined) {
      throw new Error(`Unknown or incomplete argument: ${flag}`)
    }
    options[flag.slice(2)] = value
    index += 1
  }
  return options
}

function readJson(file, what) {
  if (!existsSync(file)) throw new Error(`${what} not found: ${file}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

function main(argv) {
  const options = parseArgs(argv)
  const root = path.resolve(options.root ?? path.join(scriptDir, '..'))
  const register = () => readJson(path.resolve(root, options.register ?? DEFAULT_REGISTER), 'Fork features register')
  const reportPath = path.resolve(root, options.out ?? options.report ?? DEFAULT_REPORT)
  const upstream = options.upstream ?? 'upstream/main'

  if (options.command === 'impact') {
    const previous = existsSync(reportPath) ? readJson(reportPath, 'Previous report') : null
    const report = buildImpactReport({ root, base: options.base ?? 'HEAD', upstream, register: register(), previous })
    mkdirSync(path.dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    writeFileSync(reportPath.replace(/\.json$/, '.md'), renderMarkdown(report))
    const flagged = report.rows.filter((row) => row.flagged)
    console.log(
      `${report.upstreamCommitCount} upstream commits; ${flagged.length} of ${report.rows.length} features flagged; ${flagged.filter((row) => !row.decision).length} need a decision.`
    )
    for (const row of flagged) console.log(`  - ${row.id}: ${row.kind}${row.decision ? ` (decided: ${row.decision})` : ''}`)
    if (report.unownedConflicts.length) {
      console.log(`Conflicts in files no feature claims: ${report.unownedConflicts.join(', ')}`)
    }
    console.log(`Report: ${reportPath}`)
    return 0
  }

  if (options.command === 'gate') {
    const report = readJson(reportPath, 'Upstream impact report')
    const upstreamHead = git(root, ['rev-parse', upstream])
    const gate = checkGate(report, { upstreamHead })
    if (gate.stale) {
      console.error(
        `Upstream gate: the report is for ${report.upstreamHead.slice(0, 9)} but ${upstream} is now ${upstreamHead.slice(0, 9)}. Run the impact report again.`
      )
    }
    if (gate.undecided.length) {
      console.error('Upstream gate: these features still need your decision (keep-ours, take-theirs or adapt):')
      for (const id of gate.undecided) {
        const row = report.rows.find((candidate) => candidate.id === id)
        console.error(`  - ${id}: ${row.feature} (${row.kind})`)
      }
    }
    if (!gate.ok) return 1
    console.log('Upstream gate: every flagged feature has a decision. The merge may go ahead.')
    return 0
  }

  if (options.command === 'post-merge') {
    const failures = runChecks(register(), { root })
    if (failures.length) {
      console.error('\nFeature checks FAILED after the merge:')
      for (const failure of failures) console.error(`  - ${failure.id}: ${failure.run} (exit ${failure.status})`)
      return 1
    }
    console.log('\nEvery feature check passed after the merge.')
    return 0
  }

  throw new Error(`Unknown command: ${options.command ?? '(none)'}. Use impact, gate or post-merge.`)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 2
  }
}
