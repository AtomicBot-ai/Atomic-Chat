/**
 * Nothing but the runtimes syncs from the upstream project, and this is the
 * guard that keeps it that way.
 *
 * Radium is a fork of Atomic Chat. It used to fetch its provider list, its
 * model recommendations, its staff picks, its media registry and its model
 * catalog from upstream's repositories at every launch, recommend upstream's
 * own Hugging Face re-uploads, ship upstream's analytics (PostHog), report
 * crashes to upstream's Sentry project, install upstream's agent, and tell the
 * assistant to point users at upstream's website. Each of those let a third party change
 * what Radium shows or does without a Radium release.
 *
 * The one deliberate exception is the inference runtimes: the TurboQuant
 * llama.cpp fork, the mirrored upstream llama.cpp builds and their manifests,
 * and the MLX server. Those keep their own update channel, and the files that
 * implement it are listed in RUNTIME_FILES below with the reason.
 *
 * If this fails, you either reintroduced an upstream source (remove it — the
 * registries are bundled, see web-app/src/registries/README.md) or you are
 * touching a runtime file that is not listed (add it, with a reason, only if it
 * really is part of a runtime's update channel).
 *
 * See docs/decisions/2026-10-16-only-runtimes-sync-from-upstream.md.
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8')

/** Anything that names an upstream-owned source of data, models or software. */
const UPSTREAM_SOURCE =
  /AtomicBot-ai|atomic-chat-conf|atomic-chat-model-catalog|atomicagent\.io|atomic\.chat\b|AtomicChat\/|\.atomic-agent\b/i

/**
 * Analytics, and any hard-coded crash-report destination. The Sentry SDK itself
 * is allowed — crash reporting is Radium's own, opt-in, and its DSN comes only
 * from the build (`SENTRY_DSN`). Third-party MCP connectors named PostHog or
 * Sentry are integrations the user adds, not telemetry, and do not match.
 */
const TELEMETRY =
  /posthog-js|posthog-node|posthog\.init|[a-z]+\.i\.posthog\.com|POSTHOG_(KEY|HOST)|googletagmanager|google-analytics|https?:\/\/[0-9a-f]{16,}@[a-z0-9.-]*sentry\.io\/\d+|[0-9a-f]{32}@o\d+\.ingest/i

/** An issue reference in a comment is history, not a source. */
const ISSUE_REFERENCE = /AtomicBot-ai\/Atomic-Chat#\d+/gi

/** Files that implement a runtime's update channel, and why each may name upstream. */
const RUNTIME_FILES = {
  'extensions/llamacpp-extension/src/backend.ts':
    'TurboQuant release index and backend manifest',
  'extensions/llamacpp-upstream-extension/src/backend.ts':
    'mirrored upstream llama.cpp backend manifest',
  'extensions/llamacpp-upstream-extension/src/bundledManifestBaseline.ts':
    'offline copy of that manifest',
  'extensions/llamacpp-upstream-extension/src/index.ts':
    'backend catalog refresh (comments name the manifest)',
  'src-tauri/tauri.conf.json':
    'CSP allows the backend-manifest path for the WebView fetch',
  'src-tauri/src/core/agent/ARCHITECTURE.md':
    'e2e harness runs against the TurboQuant llama-server',
  'Makefile': 'backend and MLX server downloads at build time',
  '.github/workflows/release.yml': 'bundles the backends at build time',
  '.github/workflows/windows-test-build.yml': 'bundles the TurboQuant backend',
  'scripts/resolve-upstream-backend.mjs': 'resolves the bundled backend',
  'scripts/build-windows-release.ps1': 'bundles the backends at build time',
  'scripts/dev-windows.ps1': 'downloads the backends for a dev build',
  'scripts/resolve-turboquant-release.sh': 'resolves the TurboQuant release',
  'scripts/windows-backend-bundle.json': 'pinned backend archives',
  'scripts/sync-upstream-baseline.mjs':
    'regenerates the offline backend-manifest baseline',
  'web-app/scripts/snapshot-registries.mjs':
    'defines the pattern it refuses to snapshot',
}

const SCOPE =
  /^(web-app\/(src|scripts|index\.html|vite\.config|package\.json)|extensions\/[^/]+\/(src|package\.json|rolldown)|src-tauri\/(src|tauri[^/]*\.json|Cargo\.toml|build\.rs|capabilities)|core\/src|scripts\/|\.github\/workflows\/|package\.json$|Makefile$)/
const TEST_FILE =
  /(\.test\.|\.spec\.|__tests__\/|__mocks__\/|\/tests?\/|_tests\.rs$|\.snap$)/
const TEXT_FILE =
  /\.(m?[jt]sx?|json|rs|toml|ya?ml|html|md|sh|ps1|py|mjs)$|Makefile$/

function productionFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => SCOPE.test(f) && !TEST_FILE.test(f) && TEXT_FILE.test(f))
    .filter((f) => existsSync(path.join(repoRoot, f)))
}

function offending(text, pattern) {
  return text
    .split('\n')
    .map((line, i) => [i + 1, line.replace(ISSUE_REFERENCE, '')])
    .filter(([, line]) => pattern.test(line))
}

test('the scan covers the app, the extensions, the backend and CI', () => {
  const files = productionFiles()
  for (const expected of [
    'web-app/src/main.tsx',
    'web-app/src/constants/models.ts',
    'extensions/assistant-extension/src/index.ts',
    'src-tauri/src/lib.rs',
    '.github/workflows/release.yml',
  ]) {
    assert.ok(files.includes(expected), `${expected} is not scanned`)
  }
  assert.ok(files.length > 500, `only ${files.length} files scanned`)
})

test('no production file names an upstream source outside the runtimes', () => {
  const hits = []
  for (const f of productionFiles()) {
    if (f in RUNTIME_FILES) continue
    for (const [n, line] of offending(read(f), UPSTREAM_SOURCE)) {
      hits.push(`${f}:${n}: ${line.trim().slice(0, 160)}`)
    }
  }
  assert.deepEqual(hits, [], `upstream sources found:\n${hits.join('\n')}`)
})

test('runtime files name upstream only for runtimes', () => {
  // A runtime file may name the backend repositories and the manifest repo,
  // but not a registry, the catalog, the agent or the website.
  const NOT_RUNTIME =
    /atomic-chat-conf\/main\/(providers|models|media|staff)|atomic-chat-model-catalog|atomicagent\.io|atomic\.chat\b|AtomicChat\/|\.atomic-agent\b/i
  const hits = []
  for (const f of Object.keys(RUNTIME_FILES)) {
    assert.ok(existsSync(path.join(repoRoot, f)), `${f} is listed but gone`)
    for (const [n, line] of offending(read(f), NOT_RUNTIME)) {
      if (f === 'web-app/scripts/snapshot-registries.mjs') continue
      hits.push(`${f}:${n}: ${line.trim().slice(0, 160)}`)
    }
  }
  assert.deepEqual(hits, [], hits.join('\n'))
})

test('no analytics, and no hard-coded crash-report DSN', () => {
  const hits = []
  for (const f of productionFiles()) {
    if (f === 'web-app/scripts/snapshot-registries.mjs') continue
    for (const [n, line] of offending(read(f), TELEMETRY)) {
      hits.push(`${f}:${n}: ${line.trim().slice(0, 160)}`)
    }
  }
  assert.deepEqual(
    hits,
    [],
    `analytics or a hard-coded DSN found:\n${hits.join('\n')}`
  )
})

test('crash reporting is opt-in and its DSN comes only from the build', () => {
  const source = read('web-app/src/lib/crash-reporting.ts')
  assert.match(source, /enabled: false/, 'crash reporting must default to off')
  assert.match(source, /SENTRY_DSN/, 'the DSN must come from the build define')
  assert.match(source, /sendDefaultPii: false/)
  assert.match(source, /beforeSend:/)
  const vite = read('web-app/vite.config.ts')
  assert.match(vite, /SENTRY_DSN: JSON\.stringify\(env\.SENTRY_DSN \?\? ''\)/)
  for (const pkg of ['package.json', 'web-app/package.json']) {
    assert.ok(!/posthog/i.test(read(pkg)), `${pkg} depends on PostHog`)
  }
})

test('no registry default points anywhere: every VITE_*_URL override is empty', () => {
  const source = read('web-app/src/lib/registry-source.ts')
  assert.ok(
    !/https?:\/\//.test(source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')),
    'registry-source.ts hard-codes a URL'
  )
  for (const name of [
    'VITE_PROVIDER_REGISTRY_URL',
    'VITE_RECOMMENDED_MODELS_REGISTRY_URL',
    'VITE_STAFF_PICKS_REGISTRY_URL',
    'VITE_MEDIA_REGISTRY_URL',
    'VITE_MODEL_CATALOG_URL',
    'VITE_MODEL_CATALOG_INDEX_URL',
  ]) {
    assert.ok(source.includes(name), `${name} is not read`)
  }
})

test('the bundled snapshots are clean', () => {
  const snapshots = [
    'web-app/src/registries/providers.json',
    'web-app/src/registries/recommended-models.json',
    'web-app/src/registries/staff-picks.json',
    'web-app/src/registries/media.json',
  ].map((f) => [f, read(f)])
  for (const f of [
    'web-app/public/seed-catalog.json.gz',
    'web-app/public/seed-catalog.idx.json.gz',
  ]) {
    snapshots.push([
      f,
      gunzipSync(readFileSync(path.join(repoRoot, f))).toString('utf8'),
    ])
  }
  for (const [f, text] of snapshots) {
    JSON.parse(text)
    const m = text.match(UPSTREAM_SOURCE)
    assert.equal(m, null, `${f} references ${m?.[0]}`)
  }
})
