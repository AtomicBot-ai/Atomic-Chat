import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const floorPath = join(root, 'tests', 'coverage-floor.json')

const summaryRoots = [
  join(root, 'coverage', 'coverage-summary.json'),
  join(root, 'web-app', 'coverage', 'coverage-summary.json'),
  join(root, 'core', 'coverage', 'coverage-summary.json'),
  join(
    root,
    'extensions',
    'llamacpp-extension',
    'coverage',
    'coverage-summary.json'
  ),
  join(
    root,
    'extensions',
    'llamacpp-upstream-extension',
    'coverage',
    'coverage-summary.json'
  ),
]

const targetPaths = [
  'web-app/src/lib/custom-chat-transport.ts',
  'web-app/src/containers/SetupScreen.tsx',
  'web-app/src/containers/SetupBackendStep.tsx',
  'web-app/src/utils/getModelToStart.ts',
  'web-app/src/hooks/useModelProvider.ts',
  'web-app/src/services/staff-picks-registry.ts',
  'web-app/src/lib/hub-filters.ts',
  'extensions/llamacpp-extension/src/backend.ts',
  'extensions/llamacpp-upstream-extension/src/backend.ts',
]
const metricNames = ['statements', 'branches', 'functions', 'lines']

function normalizePath(path) {
  return path.replaceAll('\\', '/')
}

function collectSummaries() {
  const collected = new Map()
  const existingSummaries = summaryRoots
    .filter((path) => existsSync(path))
    .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs)

  for (const path of existingSummaries) {
    const summary = JSON.parse(readFileSync(path, 'utf8'))
    for (const [sourcePath, metrics] of Object.entries(summary)) {
      if (sourcePath === 'total') continue
      const absolutePath = resolve(dirname(path), '..', sourcePath)
      const relativePath = normalizePath(relative(root, absolutePath))
      collected.set(relativePath, metrics)

      const directRelativePath = normalizePath(relative(root, sourcePath))
      if (!directRelativePath.startsWith('..')) {
        collected.set(directRelativePath, metrics)
      }
    }
  }
  return collected
}

function findMetrics(summaries, target) {
  if (summaries.has(target)) return summaries.get(target)
  for (const [path, metrics] of summaries) {
    if (path.endsWith(target)) return metrics
  }
  return undefined
}

const summaries = collectSummaries()
const missingSummaries = summaryRoots.filter((path) => !existsSync(path))
if (summaries.size === 0) {
  console.error(
    'No coverage summaries found. Run the coverage test targets first.'
  )
  process.exit(1)
}

const current = {}
const missingTargets = []
for (const target of targetPaths) {
  const metrics = findMetrics(summaries, target)
  if (!metrics) {
    missingTargets.push(target)
    continue
  }
  current[target] = Object.fromEntries(
    metricNames.map((metric) => [metric, metrics[metric].pct])
  )
}

if (missingTargets.length > 0) {
  console.error('Critical coverage targets missing from generated summaries:')
  for (const target of missingTargets) console.error(`- ${target}`)
  if (missingSummaries.length > 0) {
    console.error('Coverage commands did not produce:')
    for (const path of missingSummaries) {
      console.error(`- ${normalizePath(relative(root, path))}`)
    }
  }
  process.exit(1)
}

if (process.env.UPDATE_COVERAGE_FLOOR === '1') {
  writeFileSync(floorPath, `${JSON.stringify(current, null, 2)}\n`)
  console.log(`Updated ${normalizePath(relative(root, floorPath))}.`)
  process.exit(0)
}

if (!existsSync(floorPath)) {
  console.error(
    `Coverage floor is missing. Run UPDATE_COVERAGE_FLOOR=1 node scripts/check-coverage-floor.mjs.`
  )
  process.exit(1)
}

const floor = JSON.parse(readFileSync(floorPath, 'utf8'))
const regressions = []
for (const target of targetPaths) {
  if (!floor[target]) {
    regressions.push(`${target}: no committed floor`)
    continue
  }
  for (const metric of metricNames) {
    if (current[target][metric] < floor[target][metric]) {
      regressions.push(
        `${target} ${metric}: ${current[target][metric]} < ${floor[target][metric]}`
      )
    }
  }
}

if (regressions.length > 0) {
  console.error('Critical-flow coverage regressed:')
  for (const regression of regressions) console.error(`- ${regression}`)
  process.exit(1)
}

console.log(`Coverage floor passed (${targetPaths.length} critical files).`)
