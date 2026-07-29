import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const allowlistPath = join(root, 'tests', 'test-quality-allowlist.json')
const allowlist = existsSync(allowlistPath)
  ? JSON.parse(readFileSync(allowlistPath, 'utf8'))
  : {}

const ignoredDirectories = new Set([
  '.git',
  '.yarn',
  'coverage',
  'dist',
  'node_modules',
  'target',
])

function walk(directory, predicate) {
  const matches = []
  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) continue
    const path = join(directory, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) {
      matches.push(...walk(path, predicate))
    } else if (predicate(path)) {
      matches.push(path)
    }
  }
  return matches
}

const testFiles = walk(
  root,
  (path) =>
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /[/\\](tests?|__tests__)[/\\].*\.[cm]?[jt]sx?$/.test(path)
)
const sourceFiles = walk(
  root,
  (path) =>
    /\.[cm]?[jt]sx?$/.test(path) &&
    !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) &&
    !/[/\\](tests?|__tests__)[/\\]/.test(path)
)

const exportedFunctionNames = new Set()
for (const path of sourceFiles) {
  const source = readFileSync(path, 'utf8')
  for (const match of source.matchAll(
    /\bexport\s+(?:async\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)/g
  )) {
    exportedFunctionNames.add(match[1])
  }
  for (const match of source.matchAll(
    /^\s{2,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/gm
  )) {
    exportedFunctionNames.add(match[1])
  }
}

function subjectName(path) {
  return path
    .split(/[/\\]/)
    .pop()
    .replace(/\.(test|spec)\.[cm]?[jt]sx?$/, '')
    .replace(/\.simple$/, '')
}

function extractTestBodies(source) {
  const bodies = []
  const startPattern = /\b(?:it|test)\s*\(\s*(['"`]).*?\1\s*,/gs
  for (const match of source.matchAll(startPattern)) {
    const arrow = source.indexOf('=>', match.index + match[0].length)
    if (arrow === -1) continue
    const open = source.indexOf('{', arrow)
    if (open === -1) continue
    let depth = 1
    let quote = null
    let escaped = false
    for (let index = open + 1; index < source.length; index += 1) {
      const character = source[index]
      if (quote) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === quote) quote = null
        continue
      }
      if (character === "'" || character === '"' || character === '`') {
        quote = character
      } else if (character === '{') {
        depth += 1
      } else if (character === '}') {
        depth -= 1
        if (depth === 0) {
          bodies.push(source.slice(open + 1, index))
          break
        }
      }
    }
  }
  return bodies
}

function isAllowed(rule, path) {
  const normalized = relative(root, path).replaceAll('\\', '/')
  return (allowlist[rule] ?? []).includes(normalized)
}

const violations = []
function report(rule, path, detail) {
  if (!isAllowed(rule, path)) {
    violations.push({
      rule,
      path: relative(root, path).replaceAll('\\', '/'),
      detail,
    })
  }
}

for (const path of testFiles) {
  const source = readFileSync(path, 'utf8')
  const subject = subjectName(path)

  if (/expect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)/.test(source)) {
    report('tautological-expect', path, 'contains expect(true).toBe(true)')
  }

  for (const match of source.matchAll(/\bvi\.mock\s*\(\s*(['"`])(.+?)\1/g)) {
    const specifier = match[2]
    if (!specifier.startsWith('.')) continue
    const testDirectory = dirname(path)
    const productionDirectory = /^(?:tests?|__tests__)$/.test(
      testDirectory.split(/[/\\]/).pop()
    )
      ? dirname(testDirectory)
      : testDirectory
    const mockedPath = resolve(testDirectory, specifier).replace(
      /\.[cm]?[jt]sx?$/,
      ''
    )
    const subjectPath = resolve(productionDirectory, subject)
    if (mockedPath === subjectPath) {
      report(
        'mocked-subject',
        path,
        `mocks its production subject "${specifier}"`
      )
    }
  }

  const mockComponent = new RegExp(
    `(?:const|function)\\s+Mock${subject}\\b[\\s\\S]*?<Mock${subject}\\b`
  )
  if (mockComponent.test(source)) {
    report(
      'replacement-component',
      path,
      `renders local Mock${subject} instead of the production component`
    )
  }

  for (const body of extractTestBodies(source)) {
    const matchers = [
      ...body.matchAll(
        /\bexpect\s*\([\s\S]*?\)\s*\.\s*(?:(?:not|resolves|rejects)\s*\.\s*)*([A-Za-z_$][\w$]*)\s*\(/g
      ),
    ].map((match) => match[1])
    if (
      matchers.length > 0 &&
      matchers.every((matcher) =>
        /^toHaveBeenCalled(?:Once|Times|With|Before|After)?$/.test(matcher)
      )
    ) {
      report(
        'call-only-assertions',
        path,
        'contains a test whose only assertions check mock invocation'
      )
      break
    }
  }

  for (const match of source.matchAll(
    /\b(?:const|function)\s+([A-Za-z_$][\w$]*)\s*(?:=|\()/g
  )) {
    const name = match[1]
    if (
      /^(?:build|convert|format|normalize|parse|repair|sanitize|select)/.test(
        name
      ) &&
      exportedFunctionNames.has(name)
    ) {
      report(
        'duplicated-production-helper',
        path,
        `defines "${name}", which is exported by production code`
      )
    }
  }
}

const evidenceMapPath = join(root, 'docs', 'testing-critical-flows.md')
const evidenceMap = readFileSync(evidenceMapPath, 'utf8')
const testPathsByName = new Map()
for (const path of testFiles) {
  const name = path.split(/[/\\]/).pop()
  const paths = testPathsByName.get(name) ?? []
  paths.push(path)
  testPathsByName.set(name, paths)
}
for (const match of evidenceMap.matchAll(
  /`([^`\n]*\.(?:test|spec)\.[cm]?[jt]sx?)`/g
)) {
  const reference = match[1]
  const referencedPath = resolve(root, reference)
  const basename = reference.split('/').pop()
  if (!existsSync(referencedPath) && !testPathsByName.has(basename)) {
    violations.push({
      rule: 'stale-evidence-link',
      path: 'docs/testing-critical-flows.md',
      detail: `references missing test "${reference}"`,
    })
  }
}

if (violations.length > 0) {
  console.error('Test-quality guard found new false-confidence patterns:')
  for (const violation of violations) {
    console.error(
      `- [${violation.rule}] ${violation.path}: ${violation.detail}`
    )
  }
  console.error(
    `Fix the test, or document an existing exception in ${relative(root, allowlistPath)}.`
  )
  process.exit(1)
}

console.log(`Test-quality guard passed (${testFiles.length} files scanned).`)
