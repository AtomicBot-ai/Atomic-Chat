#!/usr/bin/env node
// Regenerate the app's snapshots of atomic-chat-conf: the upstream release
// list and legacy manifest fixtures the contract tests read, and the model
// catalog baselines the web app falls back to offline.
//
// The upstream offline baseline itself lives in atomic-chat-core now (it owns
// the backend index since ADR 2026-09-27), so the extension no longer ships
// one; see ADR 2026-10-13-bundle-the-upstream-release-the-pinned-core-would-choose.
//
// Writes:
//   tests/fixtures/registries/upstream-releases.json  (backends/llamacpp-upstream-releases.json)
//   tests/fixtures/registries/upstream-manifest.json  (backends/manifest.json)
//   tests/fixtures/registries/sources.json  (only the pinned revision)
//   web-app/src/services/diffusion-catalog-baseline.ts   (models/diffusion.json)
//   web-app/src/services/decision-catalog-baseline.ts    (models/decision.json)
//   web-app/src/services/embedding-catalog-baseline.ts   (models/embedding.json)
//
// Usage:
//   node scripts/sync-upstream-baseline.mjs
//   node scripts/sync-upstream-baseline.mjs --from ../atomic-chat-conf/backends/manifest.json \
//                                           --releases-from ../atomic-chat-conf/backends/llamacpp-upstream-releases.json
//   node scripts/sync-upstream-baseline.mjs --catalog-from ../atomic-chat-conf/models/diffusion.json \
//                                           --decision-from ../atomic-chat-conf/models/decision.json \
//                                           --embedding-from ../atomic-chat-conf/models/embedding.json
//   node scripts/sync-upstream-baseline.mjs --revision <sha>
//   node scripts/sync-upstream-baseline.mjs --check    # fail if regeneration would change anything

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/manifest.json'
const RELEASES_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/llamacpp-upstream-releases.json'
// Every mirror commits the release list, and a promotion commits both files,
// so the list's last commit is the revision both fixtures were generated from.
// Until conf publishes the list, the manifest's last commit is.
const COMMITS_APIS = [
  'https://api.github.com/repos/AtomicBot-ai/atomic-chat-conf/commits?path=backends/llamacpp-upstream-releases.json&per_page=1',
  'https://api.github.com/repos/AtomicBot-ai/atomic-chat-conf/commits?path=backends/manifest.json&per_page=1',
]
const DIFFUSION_CATALOG_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/diffusion.json'
const DECISION_CATALOG_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/decision.json'
const EMBEDDING_CATALOG_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/embedding.json'

const RELEASES_FIXTURE_JSON = join(ROOT, 'tests/fixtures/registries/upstream-releases.json')
const FIXTURE_JSON = join(ROOT, 'tests/fixtures/registries/upstream-manifest.json')
const SOURCES_JSON = join(ROOT, 'tests/fixtures/registries/sources.json')
const DIFFUSION_CATALOG_TS = join(
  ROOT,
  'web-app/src/services/diffusion-catalog-baseline.ts'
)
const DECISION_CATALOG_TS = join(
  ROOT,
  'web-app/src/services/decision-catalog-baseline.ts'
)
const EMBEDDING_CATALOG_TS = join(
  ROOT,
  'web-app/src/services/embedding-catalog-baseline.ts'
)

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

function die(message) {
  process.stderr.write(`Error: ${message}\n`)
  process.exit(1)
}

/**
 * The fixture is the manifest verbatim (the "exact" fixture in sources.json),
 * so contract tests assert against the shape the app really receives.
 */
export function renderFixture(manifest) {
  const head = [
    `  "$schema": "./schema.json"`,
    `  "updated_at": ${JSON.stringify(manifest.updated_at)}`,
    `  "tag_name": ${JSON.stringify(manifest.tag_name)}`,
  ]
  if (manifest.download_base) {
    head.push(`  "download_base": ${JSON.stringify(manifest.download_base)}`)
  }
  // One asset per line, matching how the manifest itself is written: a
  // fully-expanded object per asset turns every tag bump into an unreadable diff.
  const assets = manifest.assets
    .map((asset) => {
      const fields = Object.entries(asset).map(
        ([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`
      )
      return `    { ${fields.join(', ')} }`
    })
    .join(',\n')
  return `{\n${head.join(',\n')},\n  "assets": [\n${assets}\n  ]\n}\n`
}

/** The release list verbatim, as conf writes it (two-space JSON). */
export function renderReleasesFixture(list) {
  if (list?.schema_version !== 1 || !Array.isArray(list.releases) || list.releases.length === 0) {
    throw new Error('release list has no releases this script reads')
  }
  return `${JSON.stringify(list, null, 2)}\n`
}

/** The release list, or `null` while conf does not publish one (404). */
async function loadReleases(from) {
  if (from) return JSON.parse(await readFile(from, 'utf8'))
  const resp = await fetch(RELEASES_URL, {
    headers: { 'User-Agent': 'atomic-chat-baseline-sync', Accept: 'application/json' },
  })
  if (resp.status === 404) {
    process.stderr.write(`Warning: ${RELEASES_URL} is not published yet; leaving its fixture untouched\n`)
    return null
  }
  if (!resp.ok) die(`release list returned HTTP ${resp.status} from ${RELEASES_URL}`)
  return resp.json()
}

async function loadManifest(from, url = MANIFEST_URL) {
  if (from) {
    return JSON.parse(await readFile(from, 'utf8'))
  }
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'atomic-chat-baseline-sync', Accept: 'application/json' },
  })
  if (!resp.ok) {
    die(`manifest returned HTTP ${resp.status} from ${url}`)
  }
  return resp.json()
}

/**
 * The diffusion catalog is bundled verbatim minus `$schema`: the client
 * re-validates the snapshot through the same strict parser as the live
 * manifest, so a field this generator does not understand costs nothing here
 * and is dropped there.
 */
export function diffusionCatalogBaseline(catalog) {
  if (typeof catalog?.schema_version !== 'number') {
    throw new Error('diffusion catalog has no schema_version')
  }
  if (!Array.isArray(catalog.families) || catalog.families.length === 0) {
    throw new Error('diffusion catalog lists no families')
  }
  const { $schema: _schema, ...rest } = catalog
  return rest
}

export function renderDiffusionCatalogModule(baseline) {
  return `// GENERATED by scripts/sync-upstream-baseline.mjs — do not edit by hand.
//
// Offline snapshot of atomic-chat-conf/models/diffusion.json. The catalog
// registry falls back to it when the network and the cache both fail, so it
// deliberately carries real repos, byte counts and hashes. Regenerate with
// \`make sync-upstream-baseline\` after the catalog moves.
import type { DiffusionCatalog } from './diffusion-catalog-registry'

export const BASELINE_DIFFUSION_CATALOG: DiffusionCatalog = ${JSON.stringify(
    baseline,
    null,
    2
  )}
`
}

/** Verbatim minus `$schema`, like the diffusion catalog: the client re-validates it. */
export function decisionCatalogBaseline(catalog) {
  if (typeof catalog?.schema_version !== 'number') {
    throw new Error('decision catalog has no schema_version')
  }
  if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
    throw new Error('decision catalog lists no models')
  }
  const { $schema: _schema, ...rest } = catalog
  return rest
}

export function renderDecisionCatalogModule(baseline) {
  return `// GENERATED by scripts/sync-upstream-baseline.mjs — do not edit by hand.
//
// Offline snapshot of atomic-chat-conf/models/decision.json. The catalog
// registry falls back to it when the network and the cache both fail, so it
// deliberately carries real repos, revisions, byte counts and hashes.
// Regenerate with \`make sync-upstream-baseline\` after the catalog moves.
import type { DecisionCatalogManifest } from './decision-catalog-registry'

export const BASELINE_DECISION_CATALOG: DecisionCatalogManifest = ${JSON.stringify(
    baseline,
    null,
    2
  )}
`
}

/** Verbatim minus `$schema`, like the decision catalog: the client re-validates it. */
export function embeddingCatalogBaseline(catalog) {
  if (typeof catalog?.schema_version !== 'number') {
    throw new Error('embedding catalog has no schema_version')
  }
  if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
    throw new Error('embedding catalog lists no models')
  }
  const { $schema: _schema, ...rest } = catalog
  return rest
}

export function renderEmbeddingCatalogModule(baseline) {
  return `// GENERATED by scripts/sync-upstream-baseline.mjs — do not edit by hand.
//
// Offline snapshot of atomic-chat-conf/models/embedding.json. The catalog
// registry falls back to it when the network and the cache both fail, so it
// deliberately carries real repos, revisions, byte counts and hashes.
// Regenerate with \`make sync-upstream-baseline\` after the catalog moves.
import type { EmbeddingCatalogManifest } from './embedding-catalog-registry'

export const BASELINE_EMBEDDING_CATALOG: EmbeddingCatalogManifest = ${JSON.stringify(
    baseline,
    null,
    2
  )}
`
}

/**
 * Resolves the atomic-chat-conf commit that last touched the manifest, so the
 * fixture revision points at the exact content it was generated from. Best
 * effort: the unauthenticated API is rate-limited per IP, and a stale revision
 * is a lesser problem than a failed regeneration.
 */
async function resolveRevision(explicit) {
  if (explicit) return explicit
  try {
    for (const api of COMMITS_APIS) {
      const resp = await fetch(api, {
        headers: {
          'User-Agent': 'atomic-chat-baseline-sync',
          Accept: 'application/vnd.github+json',
        },
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const commits = await resp.json()
      const sha = commits?.[0]?.sha
      if (typeof sha === 'string' && sha) return sha
    }
    throw new Error('no commit in response')
  } catch (err) {
    process.stderr.write(
      `Warning: could not resolve the atomic-chat-conf revision (${err.message}); leaving sources.json revision untouched\n`
    )
    return null
  }
}

async function writeOrCheck(path, next, check, changed) {
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current === next) return
  changed.push(path)
  if (!check) await writeFile(path, next)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const check = args.check === true
  const manifest = await loadManifest(
    typeof args.from === 'string' ? args.from : null
  )
  if (typeof manifest?.tag_name !== 'string' || !manifest.tag_name) {
    die(`manifest has no tag_name (source: ${args.from ?? MANIFEST_URL})`)
  }
  const releases = await loadReleases(
    typeof args['releases-from'] === 'string' ? args['releases-from'] : null
  )
  let releasesFixture = null
  try {
    if (releases) releasesFixture = renderReleasesFixture(releases)
  } catch (err) {
    die(`${err.message} (source: ${args['releases-from'] ?? RELEASES_URL})`)
  }

  const catalog = await loadManifest(
    typeof args['catalog-from'] === 'string' ? args['catalog-from'] : null,
    DIFFUSION_CATALOG_URL
  )

  const decision = await loadManifest(
    typeof args['decision-from'] === 'string' ? args['decision-from'] : null,
    DECISION_CATALOG_URL
  )
  const embedding = await loadManifest(
    typeof args['embedding-from'] === 'string' ? args['embedding-from'] : null,
    EMBEDDING_CATALOG_URL
  )

  let catalogBaseline
  let decisionBaseline
  let embeddingBaseline
  try {
    catalogBaseline = diffusionCatalogBaseline(catalog)
    decisionBaseline = decisionCatalogBaseline(decision)
    embeddingBaseline = embeddingCatalogBaseline(embedding)
  } catch (err) {
    die(err.message)
  }

  const changed = []
  if (releasesFixture) await writeOrCheck(RELEASES_FIXTURE_JSON, releasesFixture, check, changed)
  await writeOrCheck(FIXTURE_JSON, renderFixture(manifest), check, changed)
  await writeOrCheck(
    DIFFUSION_CATALOG_TS,
    renderDiffusionCatalogModule(catalogBaseline),
    check,
    changed
  )
  await writeOrCheck(
    DECISION_CATALOG_TS,
    renderDecisionCatalogModule(decisionBaseline),
    check,
    changed
  )
  await writeOrCheck(
    EMBEDDING_CATALOG_TS,
    renderEmbeddingCatalogModule(embeddingBaseline),
    check,
    changed
  )

  const revision = await resolveRevision(
    typeof args.revision === 'string' ? args.revision : null
  )
  if (revision) {
    // Patched textually, not via a JSON round-trip: everything else in this
    // file is hand-maintained prose and formatting that a re-serialize would
    // churn.
    const sources = await readFile(SOURCES_JSON, 'utf8')
    const patched = sources.replace(
      /("atomic-chat-conf"\s*:\s*\{\s*"revision"\s*:\s*")[0-9a-f]{7,40}(")/,
      `$1${revision}$2`
    )
    if (patched === sources && !sources.includes(revision)) {
      die(`could not find the atomic-chat-conf revision field in ${SOURCES_JSON}`)
    }
    await writeOrCheck(SOURCES_JSON, patched, check, changed)
  }

  if (changed.length === 0) {
    process.stderr.write(`Fixtures are already at ${manifest.tag_name}\n`)
    return
  }
  if (check) {
    die(
      `fixtures are stale for manifest tag ${manifest.tag_name}; run \`make sync-upstream-baseline\`:\n  ${changed
        .map((path) => path.slice(ROOT.length + 1))
        .join('\n  ')}`
    )
  }
  process.stderr.write(
    `Synced fixtures to ${manifest.tag_name}:\n  ${changed
      .map((path) => path.slice(ROOT.length + 1))
      .join('\n  ')}\n`
  )
}

// Importable for unit tests; only the CLI path performs I/O.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => die(err.message))
}
