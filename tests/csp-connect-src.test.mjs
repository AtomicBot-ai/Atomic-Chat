/**
 * Every host the renderer fetches directly is allowed by `connect-src`, and
 * nothing else is.
 *
 * Requests made through `@tauri-apps/plugin-http` go out via the Rust HTTP
 * client, so the webview's CSP never sees them. Requests made with the
 * platform `fetch` *are* subject to it, and when CSP blocks one the failure is
 * not loud — it surfaces as a rejected promise that the call site usually
 * treats as "the network is down".
 *
 *   - `huggingface.co` is called by `fetchModelStats` in `lib/model-card.ts`
 *     with no fallback at all, inside a `try { } catch { }` that ignores the
 *     error. Blocked, it silently degrades every Hub model card to name-based
 *     guesses for parameter count and context length.
 *   - `raw.githubusercontent.com` is allowed for one path only: the llama.cpp
 *     backend manifests the engine extensions read with the WebView fetch
 *     (runtimes keep their own update channel). The configuration registries
 *     no longer come from there — they are bundled (ADR
 *     2026-10-16-only-runtimes-sync-from-upstream) — so the host as a whole
 *     is not.
 *   - Sentry's ingest hosts are allowed for Radium's own opt-in crash reports
 *     (`lib/crash-reporting.ts`; inert without a build-time DSN). They are
 *     the only telemetry hosts, and there is no analytics host at all.
 *
 * So rather than pin a hand-written list that drifts, this derives the
 * requirement from the source: any absolute `https://` literal passed to a
 * bare `fetch(` in `web-app/src` must appear in `connect-src`.
 *
 * If this fails, you either added a new direct fetch (add its host to the CSP)
 * or you are routing through `plugin-http` (then the match below is a false
 * positive, and the call should not be using bare `fetch`).
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8')

const csp = JSON.parse(read('src-tauri/tauri.conf.json')).app.security.csp
const connectSrc = csp['connect-src']

/** Hosts reached by a bare `fetch('https://…')` in shipped renderer code. */
function directlyFetchedHosts() {
  // git grep keeps this to tracked files and is available wherever the repo is.
  let out = ''
  try {
    out = execFileSync(
      'git',
      [
        'grep',
        '-hoE',
        'fetch\\(\\s*[\'"`]https://[a-zA-Z0-9.-]+',
        '--',
        'web-app/src',
      ],
      { cwd: repoRoot, encoding: 'utf8' }
    )
  } catch (error) {
    // git grep exits 1 when nothing matches, which is a legitimate state.
    if (error.status !== 1) throw error
  }
  const hosts = new Set()
  for (const line of out.split('\n')) {
    const match = line.match(/https:\/\/([a-zA-Z0-9.-]+)/)
    if (match) hosts.add(match[1])
  }
  // Test fixtures use example.com and friends; they never run in a webview.
  for (const placeholder of [...hosts]) {
    if (/(^|\.)example\.(com|org|net)$/.test(placeholder))
      hosts.delete(placeholder)
  }
  return [...hosts].sort()
}

test('the renderer does make direct https fetches worth guarding', () => {
  assert.ok(
    directlyFetchedHosts().length > 0,
    'found no direct https fetches; this guard would pass vacuously'
  )
})

test('connect-src allows every host the renderer fetches directly', () => {
  for (const host of directlyFetchedHosts()) {
    assert.ok(
      connectSrc.includes(`https://${host}`),
      `the renderer calls https://${host} with bare fetch, but connect-src ` +
        `does not allow it, so the request is blocked in the packaged app ` +
        `(often silently). connect-src is: ${connectSrc}`
    )
  }
})

test('connect-src still admits loopback for the local model servers', () => {
  // llama.cpp, the local API server and the MLX server are all loopback; a
  // tightening that drops these takes local inference with it.
  for (const required of ['http://127.0.0.1:*', 'ws://127.0.0.1:*']) {
    assert.ok(
      connectSrc.includes(required),
      `connect-src no longer allows ${required}; local inference needs it`
    )
  }
})

test('no analytics host is allowed anywhere in the CSP', () => {
  const all = JSON.stringify(csp)
  for (const host of ['posthog', 'google-analytics', 'googletagmanager']) {
    assert.ok(!all.includes(host), `the CSP still allows ${host}: ${all}`)
  }
})

test('Sentry is reachable only through its ingest hosts, and only for connect', () => {
  const isSentry = (s) => /(^|\.)sentry\.io$/.test(sourceHost(s) ?? '')
  const sentry = connectSrc.split(/\s+/).filter(isSentry)
  assert.deepEqual(sentry, [
    'https://*.ingest.sentry.io',
    'https://*.ingest.us.sentry.io',
    'https://*.ingest.de.sentry.io',
  ])
  for (const [directive, value] of Object.entries(csp)) {
    if (directive === 'connect-src') continue
    const sources = [value].flat().join(' ').split(/\s+/)
    assert.deepEqual(sources.filter(isSentry), [], `${directive} allows Sentry`)
  }
})

/** The host of a CSP source expression, or null for keywords and schemes. */
function sourceHost(source) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/:]+)/i.exec(source)
  return m ? m[1].toLowerCase() : null
}

test('raw.githubusercontent.com is allowed only for the backend manifests', () => {
  const sources = connectSrc
    .split(/\s+/)
    .filter((s) => sourceHost(s) === 'raw.githubusercontent.com')
  assert.deepEqual(sources, [
    'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/',
  ])
})
