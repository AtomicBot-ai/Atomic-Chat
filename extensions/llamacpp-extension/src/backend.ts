import { getJanDataFolderPath, fs, joinPath } from '@janhq/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { getVersion } from '@tauri-apps/api/app'
import { getSystemInfo } from './hardware'
import { getProxyConfig } from './util'
import {
  getLocalInstalledBackendsInternal,
  normalizeFeatures,
  determineSupportedBackends,
  listSupportedBackendsFromRust,
  BackendVersion,
  getSupportedFeaturesFromRust,
  mapOldBackendToNew,
} from '../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index'

// The TurboQuant provider (this extension) points at our llama.cpp fork
// AtomicBot-ai/atomic-llama-cpp-turboquant. The backend *index* — which
// releases exist and which variants each one carries — is resolved at runtime
// from `index.json`, published as an asset of every release. `releases/latest`
// is GitHub's own pointer at the newest non-prerelease release, so no release
// tag is ever hardcoded in the app and a new fork release reaches users
// without shipping a new Atomic Chat build.
//
// Only stable releases of the unified `b<upstream-build>-<fork-semver>` scheme
// are installable. `dev-latest` and the legacy per-variant
// `turboquant-<id>-<sha>` releases are prereleases: they are never offered for
// download, although an already-installed legacy build keeps working.
//
// The backend *archives* themselves are downloaded from the GitHub releases
// CDN via LLAMACPP_DOWNLOAD_BASE.
export const TURBOQUANT_RELEASE_INDEX_URL =
  'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/latest/download/index.json'
/** Redirects to `/releases/tag/<newest stable tag>`; used when index.json is absent. */
export const TURBOQUANT_LATEST_RELEASE_URL =
  'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/latest'
/**
 * Legacy index channel (ADR 2026-06-17). Read from `main` — not a pinned
 * revision — so it keeps tracking the fork while the releases catch up with
 * `index.json`.
 */
export const TURBOQUANT_LEGACY_MANIFEST_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/turboquant-manifest.json'
const LLAMACPP_DOWNLOAD_BASE =
  'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download'
/** ggml-org companion archives — same source the upstream provider uses. */
const GGML_ORG_CUDART_DOWNLOAD_BASE =
  'https://github.com/ggml-org/llama.cpp/releases/download'
/**
 * Pinned ggml-org tag that ships `cudart-llama-bin-win-cuda-{12.4,13.3}-x64.zip`.
 * A real pin, unlike the upstream extension's `BUNDLED_BASELINE_TAG`, which is
 * generated from the manifest: the cudart companions are not mirrored and this
 * driver has no manifest field to follow. Known debt, tracked in the mirroring
 * ADR.
 */
export const GGML_ORG_CUDART_PINNED_TAG = 'b10205'
const MANIFEST_FETCH_TIMEOUT_MS = 8_000

/** Schema version of `index.json` this client understands. */
export const TURBOQUANT_INDEX_SCHEMA_VERSION = 1
const RELEASE_INDEX_TTL_MS = 60 * 60 * 1000
const RELEASE_INDEX_CACHE_FILE = 'release-index.cache.json'

/** Clean TurboQuant Windows CUDA ids, e.g. `windows-x64-cuda-13.3`. */
const TQ_WINDOWS_CUDA_BACKEND_RE = /^windows-x64-cuda-(12\.\d+|13\.\d+)$/

/** Unified fork release tag: `b<upstream-build>-<fork-semver>`. */
const TQ_UNIFIED_TAG_RE = /^b\d+-\d+\.\d+\.\d+$/

/**
 * Whether a version string names a build from the TurboQuant fork's release
 * train — either a legacy per-variant tag (`turboquant-<id>-<sha>`) or a
 * unified release tag (`b10018-1.3.0`).
 *
 * A plain upstream tag (`b8149`) is deliberately not one: those can end up in
 * this provider's backend tree from an old install and must still be treated as
 * a foreign build that needs migrating.
 *
 * Accepts either a bare version or a full `version/backend` string.
 */
export function isTurboQuantRelease(versionOrPair: string): boolean {
  const version = versionOrPair.split('/')[0]
  return version.startsWith('turboquant-') || TQ_UNIFIED_TAG_RE.test(version)
}

/**
 * Whether a tag names an installable *stable* release. Narrower than
 * `isTurboQuantRelease`: legacy `turboquant-<id>-<sha>` tags and the rolling
 * `dev-latest` tag are prereleases of the fork, so they must never be offered
 * for download — but a legacy build already sitting on disk stays recognised
 * as ours by `isTurboQuantRelease` and keeps running.
 */
export function isStableReleaseTag(versionOrPair: string): boolean {
  const version = (versionOrPair ?? '')
    .replace(/\uFEFF/g, '')
    .trim()
    .split('/')[0]
  return TQ_UNIFIED_TAG_RE.test(version)
}

/**
 * Orders two release tags, newest first: `>0` when `a` supersedes `b`.
 *
 * Stable tags compare numerically on `(upstream build, fork major, minor,
 * patch)`. A stable tag always supersedes a legacy `turboquant-<id>-<sha>` one,
 * whose short SHA carries no order at all — two legacy tags therefore compare
 * equal rather than pretending one is newer.
 */
export function compareBackendVersions(a: string, b: string): number {
  const rank = (tag: string): number[] => {
    const match = /^b(\d+)-(\d+)\.(\d+)\.(\d+)$/.exec(
      (tag ?? '').replace(/\uFEFF/g, '').trim()
    )
    return match
      ? [1, ...match.slice(1).map((n) => Number.parseInt(n, 10))]
      : [0, 0, 0, 0, 0]
  }
  const left = rank(a)
  const right = rank(b)
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}

/** One platform/backend archive inside a release. */
export interface TurboquantVariant {
  id: string
  asset?: string
  size?: number
  sha256?: string
}

/** One release of the fork, as described by `index.json`. */
export interface TurboquantRelease {
  tag: string
  published_at?: string
  commit?: string
  prerelease?: boolean
  /** Minimum Atomic Chat version that can run this build; absent = any. */
  min_app_version?: string
  title?: string
  highlights?: string[]
  variants: TurboquantVariant[]
}

export interface TurboquantCatalog {
  /** Newest stable tag the client accepted, or null when nothing is usable. */
  latest: string | null
  /** Stable, app-compatible releases, newest first. */
  releases: TurboquantRelease[]
  source: 'index' | 'redirect' | 'legacy-manifest' | 'disk-cache' | 'none'
}

const EMPTY_CATALOG: TurboquantCatalog = {
  latest: null,
  releases: [],
  source: 'none',
}

interface TurboquantManifestEntry {
  id: string
  tag: string
  asset: string
}

interface CachedCatalog {
  fetched_at: number
  catalog: TurboquantCatalog
}

let _memoryCache: CachedCatalog | null = null
let _inFlight: Promise<TurboquantCatalog> | null = null

export async function getLocalInstalledBackends(): Promise<BackendVersion[]> {
  const janDataFolderPath = await getJanDataFolderPath()
  const backendDir = await joinPath([janDataFolderPath, 'llamacpp', 'backends'])
  return await getLocalInstalledBackendsInternal(backendDir)
}
// folder structure
// <Jan's data folder>/llamacpp/backends/<backend_version>/<backend_type>

export interface InstalledBackendPack {
  version: string
  backend: string
  path: string
  active: boolean
}

const clean = (value: string) => value.replace(/\uFEFF/g, '').trim()

export interface BackendOption {
  value: string
  name: string
}

/**
 * Flattens the version-dropdown tiers into one list.
 *
 * The tiers are passed most-preferred first and the first spelling of a
 * `version/backend` wins, so a build that appears in several tiers keeps its
 * richest label. `recommended` is forced into the list because a
 * recommendation the dropdown cannot offer is a dead end: the UI would mark a
 * version the user has no way to select.
 */
export function mergeBackendOptions(
  tiers: BackendOption[][],
  recommended?: BackendOption
): BackendOption[] {
  const merged: BackendOption[] = []
  const seen = new Set<string>()

  for (const tier of tiers) {
    for (const option of tier) {
      const value = clean(option.value)
      if (!value || seen.has(value)) continue
      seen.add(value)
      merged.push({ value, name: option.name })
    }
  }

  const recommendedValue = recommended ? clean(recommended.value) : ''
  if (recommendedValue && !seen.has(recommendedValue)) {
    merged.unshift({ value: recommendedValue, name: recommended!.name })
  }

  return merged
}

/**
 * Every backend build sitting in this provider's tree, with the absolute path
 * of each so the UI can reveal it in the file manager, and a flag marking the
 * one currently selected (which must not be deletable).
 */
export async function listInstalledBackendPacks(
  providerId: string,
  currentVersionBackend: string
): Promise<InstalledBackendPack[]> {
  const janDataFolderPath = await getJanDataFolderPath()
  const backendsRoot = await joinPath([
    janDataFolderPath,
    providerId,
    'backends',
  ])
  const current = clean(currentVersionBackend)
  const installed = await getLocalInstalledBackends()

  return Promise.all(
    installed.map(async (entry) => {
      const version = clean(entry.version)
      const backend = clean(entry.backend)
      return {
        version,
        backend,
        path: await joinPath([backendsRoot, version, backend]),
        active: `${version}/${backend}` === current,
      }
    })
  )
}

/**
 * Removes one installed backend build. The selected build is refused rather
 * than silently skipped: deleting it would leave `version_backend` pointing at
 * a directory that no longer exists and the next model load would fail with a
 * missing-binary error instead of anything actionable.
 */
export async function deleteBackendPack(
  providerId: string,
  currentVersionBackend: string,
  version: string,
  backend: string
): Promise<void> {
  const cleanVersion = clean(version)
  const cleanBackend = clean(backend)
  if (!cleanVersion || !cleanBackend) {
    throw new Error(`Invalid backend pack: '${version}/${backend}'`)
  }
  if (/[/\\]/.test(cleanVersion) || /[/\\]/.test(cleanBackend)) {
    throw new Error(`Invalid backend pack: '${version}/${backend}'`)
  }
  if (`${cleanVersion}/${cleanBackend}` === clean(currentVersionBackend)) {
    throw new Error('Cannot remove the backend that is currently selected')
  }

  const janDataFolderPath = await getJanDataFolderPath()
  const versionDir = await joinPath([
    janDataFolderPath,
    providerId,
    'backends',
    cleanVersion,
  ])
  const backendDir = await joinPath([versionDir, cleanBackend])

  if (await fs.existsSync(backendDir)) {
    await fs.rm(backendDir)
  }

  // A version dir holding no builds is an empty husk that would keep showing
  // up in the packs list.
  const remaining: string[] = (await fs.existsSync(versionDir))
    ? await fs.readdirSync(versionDir)
    : []
  if (remaining.length === 0 && (await fs.existsSync(versionDir))) {
    await fs.rm(versionDir)
  }
}

/**
 * Maps the app's stored proxy config (`getProxyConfig`, shaped for the Rust
 * `download_files` command) onto the option shape `@tauri-apps/plugin-http`'s
 * `fetch` expects. Returns `{}` when no proxy is enabled so the caller can
 * spread it unconditionally.
 */
function buildHttpProxyOptions(): {
  proxy?: {
    all: {
      url: string
      basicAuth?: { username: string; password: string }
      noProxy?: string
    }
  }
  danger?: { acceptInvalidCerts?: boolean; acceptInvalidHostnames?: boolean }
} {
  const cfg = getProxyConfig()
  if (!cfg || typeof cfg.url !== 'string' || !cfg.url) {
    return {}
  }

  const proxyConfig: {
    url: string
    basicAuth?: { username: string; password: string }
    noProxy?: string
  } = { url: cfg.url }

  if (typeof cfg.username === 'string' && typeof cfg.password === 'string') {
    proxyConfig.basicAuth = { username: cfg.username, password: cfg.password }
  }
  if (Array.isArray(cfg.no_proxy) && cfg.no_proxy.length > 0) {
    proxyConfig.noProxy = (cfg.no_proxy as string[]).join(',')
  }

  if (cfg.ignore_ssl === true) {
    return {
      proxy: { all: proxyConfig },
      danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
    }
  }
  return { proxy: { all: proxyConfig } }
}

async function fetchManifestWithTimeout(
  url: string,
  useProxy: boolean
): Promise<Response> {
  // Guard each request with a hard Promise timeout because some
  // `@tauri-apps/plugin-http` code paths may ignore AbortSignal under certain
  // network/proxy failures.
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const request = tauriFetch(url, {
    headers: { 'User-Agent': 'atomic-chat' },
    connectTimeout: MANIFEST_FETCH_TIMEOUT_MS,
    ...(useProxy ? buildHttpProxyOptions() : {}),
  })
  const timeout = new Promise<Response>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new Error(
          `Manifest fetch timed out after ${MANIFEST_FETCH_TIMEOUT_MS}ms`
        )
      )
    }, MANIFEST_FETCH_TIMEOUT_MS)
  })
  try {
    return await Promise.race([request, timeout])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

async function fetchManifestWithWebFetch(
  url: string,
  accept = 'application/json'
): Promise<Response> {
  const controller = new AbortController()
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  // `globalThis.fetch` (NOT bare `fetch`) is mandatory here: the production
  // rolldown build injects `fetch` -> `@tauri-apps/plugin-http`'s fetch (see
  // rolldown.config.mjs), so a bare `fetch` call would silently route through
  // plugin-http too. `globalThis.fetch` is the real WebView fetch, which the
  // registry loaders prove resolves reliably against the GitHub CDNs.
  const request = globalThis.fetch(url, {
    headers: { 'Accept': accept, 'User-Agent': 'atomic-chat' },
    signal: controller.signal,
  })
  const timeout = new Promise<Response>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort()
      reject(
        new Error(
          `Manifest web fetch timed out after ${MANIFEST_FETCH_TIMEOUT_MS}ms`
        )
      )
    }, MANIFEST_FETCH_TIMEOUT_MS)
  })
  try {
    return await Promise.race([request, timeout])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

async function fetchManifestWithFallbacks(
  url: string,
  accept = 'application/json'
): Promise<Response> {
  // WebView fetch is the proven-reliable primary path; the two plugin-http
  // variants are fallbacks for air-gapped/corporate-proxy setups where the
  // WebView fetch is intercepted but the Rust HTTP client is allowed through.
  const attempts: Array<{ label: string; runner: () => Promise<Response> }> = [
    {
      label: 'webview fetch',
      runner: () => fetchManifestWithWebFetch(url, accept),
    },
    {
      label: 'proxy-aware tauri fetch',
      runner: () => fetchManifestWithTimeout(url, true),
    },
    {
      label: 'direct tauri fetch',
      runner: () => fetchManifestWithTimeout(url, false),
    },
  ]

  const wrapped = attempts.map(({ label, runner }) =>
    runner()
      .then((resp) => ({ label, resp }))
      .catch((err) => {
        const reason = err instanceof Error ? err.message : String(err)
        throw new Error(`${label}: ${reason}`)
      })
  )

  try {
    const winner = await Promise.any(wrapped)
    console.info(
      `[fetchStableIndex] ${url} fetch succeeded via ${winner.label}`
    )
    return winner.resp
  } catch (aggregateErr) {
    const reasons =
      aggregateErr instanceof AggregateError
        ? aggregateErr.errors
            .map((e) => (e instanceof Error ? e.message : String(e)))
            .join(' | ')
        : aggregateErr instanceof Error
          ? aggregateErr.message
          : String(aggregateErr)
    throw new Error(`All manifest fetch attempts failed: ${reasons}`)
  }
}

/**
 * Numeric semver comparison over the leading `major.minor.patch`, ignoring any
 * prerelease/build suffix. Returns <0, 0 or >0.
 */
function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/\uFEFF/g, '')
      .trim()
      .replace(/^v/, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10))
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = Number.isFinite(left[i]) ? left[i] : 0
    const r = Number.isFinite(right[i]) ? right[i] : 0
    if (l !== r) return l - r
  }
  return 0
}

/**
 * Whether this app build satisfies a release's `min_app_version`.
 *
 * Missing or unparseable requirements pass: the field exists to stop an engine
 * that needs newer CLI wiring from auto-installing, not to gate on metadata the
 * client failed to read. An unknown app version also passes — refusing every
 * release because `getVersion()` is unavailable would be worse than the risk it
 * guards against.
 */
export function satisfiesMinAppVersion(
  minAppVersion: string | undefined,
  appVersion: string | null
): boolean {
  if (!minAppVersion || typeof minAppVersion !== 'string') return true
  if (!appVersion) return true
  if (!/^\d+(\.\d+)*/.test(minAppVersion.trim().replace(/^v/, ''))) return true
  return compareSemver(appVersion, minAppVersion) >= 0
}

async function getAppVersion(): Promise<string | null> {
  try {
    return await getVersion()
  } catch (err) {
    console.warn('[fetchStableIndex] app version unavailable:', err)
    return null
  }
}

function normalizeVariants(raw: unknown): TurboquantVariant[] {
  if (!Array.isArray(raw)) return []
  const variants: TurboquantVariant[] = []
  for (const entry of raw) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
    if (!id) continue
    variants.push({
      id,
      asset: typeof entry?.asset === 'string' ? entry.asset.trim() : undefined,
      size: typeof entry?.size === 'number' ? entry.size : undefined,
      sha256: typeof entry?.sha256 === 'string' ? entry.sha256 : undefined,
    })
  }
  return variants
}

/**
 * Turns a raw `index.json` payload into the stable, app-compatible subset.
 * Everything that is a prerelease, carries a non-unified tag, needs a newer app
 * or has no variants is dropped here rather than in the UI.
 */
function parseReleaseIndex(
  payload: unknown,
  appVersion: string | null
): TurboquantRelease[] {
  const rawReleases = (payload as { releases?: unknown })?.releases
  if (!Array.isArray(rawReleases)) return []

  const releases: TurboquantRelease[] = []
  for (const entry of rawReleases) {
    const tag = typeof entry?.tag === 'string' ? entry.tag.trim() : ''
    if (!isStableReleaseTag(tag)) continue
    if (entry?.prerelease === true) continue
    if (!satisfiesMinAppVersion(entry?.min_app_version, appVersion)) {
      console.info(
        `[fetchStableIndex] skipping ${tag}: needs app >= ${entry.min_app_version}, running ${appVersion}`
      )
      continue
    }
    const variants = normalizeVariants(entry?.variants)
    if (variants.length === 0) continue

    releases.push({
      tag,
      published_at:
        typeof entry?.published_at === 'string'
          ? entry.published_at
          : undefined,
      commit: typeof entry?.commit === 'string' ? entry.commit : undefined,
      prerelease: false,
      min_app_version:
        typeof entry?.min_app_version === 'string'
          ? entry.min_app_version
          : undefined,
      title: typeof entry?.title === 'string' ? entry.title : undefined,
      highlights: Array.isArray(entry?.highlights)
        ? entry.highlights.filter((h: unknown) => typeof h === 'string')
        : undefined,
      variants,
    })
  }

  return sortReleasesNewestFirst(releases)
}

/**
 * Newest first by `(upstream build, fork semver)` parsed out of the tag, which
 * is authoritative even when `published_at` is missing or a build was
 * re-published out of order.
 */
function sortReleasesNewestFirst(
  releases: TurboquantRelease[]
): TurboquantRelease[] {
  const rank = (tag: string): number[] => {
    const match = /^b(\d+)-(\d+)\.(\d+)\.(\d+)$/.exec(tag)
    if (!match) return [0, 0, 0, 0]
    return match.slice(1).map((n) => Number.parseInt(n, 10))
  }
  return [...releases].sort((a, b) => {
    const left = rank(a.tag)
    const right = rank(b.tag)
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return right[i] - left[i]
    }
    return 0
  })
}

/** Where the disk copy of the last good index lives. */
async function getReleaseIndexCachePath(): Promise<string> {
  const janDataFolderPath = await getJanDataFolderPath()
  return await joinPath([
    janDataFolderPath,
    'llamacpp',
    RELEASE_INDEX_CACHE_FILE,
  ])
}

async function readDiskCache(): Promise<CachedCatalog | null> {
  try {
    const path = await getReleaseIndexCachePath()
    if (!(await fs.existsSync(path))) return null
    const raw = await fs.readFileSync(path, 'utf8')
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!parsed?.catalog || !Array.isArray(parsed.catalog.releases)) return null
    return parsed as CachedCatalog
  } catch (err) {
    console.warn('[fetchStableIndex] failed to read disk cache:', err)
    return null
  }
}

async function writeDiskCache(catalog: TurboquantCatalog): Promise<void> {
  try {
    const path = await getReleaseIndexCachePath()
    const payload: CachedCatalog = { fetched_at: Date.now(), catalog }
    await fs.writeFileSync(path, JSON.stringify(payload))
  } catch (err) {
    console.warn('[fetchStableIndex] failed to write disk cache:', err)
  }
}

/** Step 1: the release-asset index, the only source carrying release notes. */
async function fetchFromReleaseIndex(
  appVersion: string | null
): Promise<TurboquantCatalog | null> {
  const resp = await fetchManifestWithFallbacks(TURBOQUANT_RELEASE_INDEX_URL)
  if (!resp.ok) {
    throw new Error(`index.json returned ${resp.status}`)
  }
  const payload = await resp.json()
  const schemaVersion = payload?.schema_version
  if (
    typeof schemaVersion === 'number' &&
    schemaVersion > TURBOQUANT_INDEX_SCHEMA_VERSION
  ) {
    // A future schema may describe releases in ways this client would
    // misread; fall through to the tag-only paths instead of guessing.
    throw new Error(
      `index.json schema_version ${schemaVersion} is newer than supported ${TURBOQUANT_INDEX_SCHEMA_VERSION}`
    )
  }
  const releases = parseReleaseIndex(payload, appVersion)
  if (releases.length === 0) return null
  return { latest: releases[0].tag, releases, source: 'index' }
}

/**
 * Step 2: no index.json yet. `/releases/latest` redirects to
 * `/releases/tag/<tag>`, which gives the newest stable tag without any API
 * call; the variant list is then synthesised from the fork's stable asset
 * naming. Yields a working catalog for releases cut before index.json existed.
 */
async function fetchFromLatestRedirect(
  supportedIds: string[]
): Promise<TurboquantCatalog | null> {
  const resp = await fetchManifestWithFallbacks(
    TURBOQUANT_LATEST_RELEASE_URL,
    'text/html'
  )
  const finalUrl = typeof resp.url === 'string' ? resp.url : ''
  const match = /\/releases\/tag\/([^/?#]+)/.exec(finalUrl)
  if (!match) {
    throw new Error(
      `could not read a release tag from the /releases/latest redirect (${finalUrl || 'no final URL'})`
    )
  }
  const tag = decodeURIComponent(match[1]).trim()
  if (!isStableReleaseTag(tag)) {
    throw new Error(`/releases/latest resolved to non-stable tag '${tag}'`)
  }
  if (supportedIds.length === 0) return null

  return {
    latest: tag,
    releases: [
      {
        tag,
        prerelease: false,
        variants: supportedIds.map((id) => ({
          id,
          asset: defaultAssetName(id),
        })),
      },
    ],
    source: 'redirect',
  }
}

/** Step 3: the legacy atomic-chat-conf manifest, kept until index.json ships. */
async function fetchFromLegacyManifest(): Promise<TurboquantCatalog | null> {
  const resp = await fetchManifestWithFallbacks(TURBOQUANT_LEGACY_MANIFEST_URL)
  if (!resp.ok) {
    throw new Error(`legacy manifest returned ${resp.status}`)
  }
  const manifest = await resp.json()
  const entries: TurboquantManifestEntry[] = Array.isArray(manifest?.backends)
    ? manifest.backends
    : []

  const byTag = new Map<string, TurboquantVariant[]>()
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.tag !== 'string')
      continue
    if (!isStableReleaseTag(entry.tag)) continue
    const variants = byTag.get(entry.tag) ?? []
    variants.push({ id: entry.id.trim(), asset: entry.asset })
    byTag.set(entry.tag, variants)
  }
  if (byTag.size === 0) return null

  const releases = sortReleasesNewestFirst(
    [...byTag.entries()].map(([tag, variants]) => ({
      tag,
      prerelease: false,
      commit:
        typeof manifest?.commit === 'string' ? manifest.commit : undefined,
      variants,
    }))
  )
  return { latest: releases[0].tag, releases, source: 'legacy-manifest' }
}

/**
 * Resolves the catalog of installable stable releases, newest first.
 *
 * Sources are tried in order — release-asset index, `/releases/latest`
 * redirect, legacy conf manifest — and the first usable answer wins. When all
 * of them fail the last good catalog is read back from disk so an offline
 * launch still sees the releases it saw yesterday; only a cold, never-online
 * install ends up with an empty catalog (bundled/local backends still work).
 */
export async function fetchStableIndex(
  options: { force?: boolean } = {}
): Promise<TurboquantCatalog> {
  const fresh =
    _memoryCache && Date.now() - _memoryCache.fetched_at < RELEASE_INDEX_TTL_MS
  if (!options.force && fresh) {
    return _memoryCache!.catalog
  }
  if (_inFlight) return _inFlight

  _inFlight = (async () => {
    const [appVersion, supportedIds] = await Promise.all([
      getAppVersion(),
      getSupportedBackendIds(),
    ])

    const steps: Array<{
      label: string
      run: () => Promise<TurboquantCatalog | null>
    }> = [
      { label: 'release index', run: () => fetchFromReleaseIndex(appVersion) },
      {
        label: '/releases/latest redirect',
        run: () => fetchFromLatestRedirect(supportedIds),
      },
      { label: 'legacy conf manifest', run: () => fetchFromLegacyManifest() },
    ]

    for (const step of steps) {
      try {
        const catalog = await step.run()
        if (catalog && catalog.releases.length > 0) {
          console.info(
            `[fetchStableIndex] resolved ${catalog.releases.length} stable release(s) via ${step.label}, latest ${catalog.latest}`
          )
          _memoryCache = { fetched_at: Date.now(), catalog }
          await writeDiskCache(catalog)
          return catalog
        }
      } catch (err) {
        console.warn(`[fetchStableIndex] ${step.label} failed:`, err)
      }
    }

    const cached = await readDiskCache()
    if (cached && cached.catalog.releases.length > 0) {
      console.warn(
        '[fetchStableIndex] all sources unreachable, serving last known good index from disk'
      )
      const catalog: TurboquantCatalog = {
        ...cached.catalog,
        source: 'disk-cache',
      }
      _memoryCache = { fetched_at: Date.now(), catalog }
      return catalog
    }

    console.warn(
      '[fetchStableIndex] no release index available, falling back to local backends only'
    )
    return EMPTY_CATALOG
  })().finally(() => {
    _inFlight = null
  })

  return _inFlight
}

/** Drops the cached index so the next read hits the network. */
export function invalidateStableIndexCache(): void {
  _memoryCache = null
}

/**
 * The archive name the fork publishes for a backend id. Windows ships `.zip`,
 * everything else `.tar.gz`. The id prefix decides, so a legacy `win-*` id
 * resolved on another host still picks the right extension; ids with no
 * platform prefix fall back to the running OS.
 */
export function defaultAssetName(backend: string): string {
  const id = backend.replace(/\uFEFF/g, '').trim()
  const isWindowsAsset = /^win(dows)?-/.test(id)
    ? true
    : /^(linux|macos|mac)-/.test(id)
      ? false
      : IS_WINDOWS
  return `llama-turboquant-${id}.${isWindowsAsset ? 'zip' : 'tar.gz'}`
}

/** Hardware-supported backend ids for this host, or `[]` when undetectable. */
async function getSupportedBackendIds(): Promise<string[]> {
  try {
    const sysInfo = await getSystemInfo()
    const rawFeatures = await _getSupportedFeatures()
    const features = normalizeFeatures(rawFeatures)
    return await determineSupportedBackends(
      sysInfo.os_type,
      sysInfo.cpu.arch,
      features
    )
  } catch (err) {
    console.warn('[fetchStableIndex] hardware probe failed:', err)
    return []
  }
}

/**
 * The installable stable builds for this machine, as `BackendVersion[]`.
 *
 * The supported-id set encodes OS/arch plus the detected GPU tier, so the user
 * never sees a variant their hardware cannot run. Every platform — macOS
 * included — resolves through the same path: the bundled build is an offline
 * baseline, not the ceiling. Returns `[]` on any failure so the app still works
 * offline with bundled/local backends only.
 */
export async function fetchRemoteBackends(
  options: { force?: boolean } = {}
): Promise<BackendVersion[]> {
  const supportedSet = new Set(await getSupportedBackendIds())
  if (supportedSet.size === 0) return []

  const catalog = await fetchStableIndex(options)
  const backends: BackendVersion[] = []
  for (const release of catalog.releases) {
    for (const variant of release.variants) {
      if (!supportedSet.has(variant.id)) continue
      backends.push({ version: release.tag, backend: variant.id, order: 0 })
    }
  }

  console.info(
    `[fetchRemoteBackends] ${backends.length} installable stable backend(s) from ${catalog.source}:`,
    backends.map((b) => `${b.version}/${b.backend}`)
  )
  return backends
}

/**
 * Builds the download URL for a specific TurboQuant backend from the
 * AtomicBot-ai/atomic-llama-cpp-turboquant releases CDN.
 *
 * `version` is the release tag the backend was resolved at, so legacy installs
 * pinned to a per-variant tag keep resolving. `assetName` comes from the
 * release index when available; without it the fork's stable naming
 * (`llama-turboquant-<id>.{zip,tar.gz}`) is reconstructed. CUDA zips *should*
 * bundle cudart/cublas inline; when they do not, `ensureCudartReady` repairs
 * by copying from an installed upstream CUDA bin or downloading the ggml-org
 * companion archive.
 */
export function getBackendDownloadUrl(
  version: string,
  backend: string,
  assetName?: string
): string {
  version = version.replace(/\uFEFF/g, '').trim()
  backend = backend.replace(/\uFEFF/g, '').trim()
  const asset =
    assetName?.replace(/\uFEFF/g, '').trim() || defaultAssetName(backend)
  return `${LLAMACPP_DOWNLOAD_BASE}/${version}/${asset}`
}

/**
 * The published asset name for `tag/backend`, read from the cached release
 * index. Returns `undefined` when the index has not been fetched or does not
 * describe this pair, leaving the caller on the naming convention.
 */
export function getIndexedAssetName(
  version: string,
  backend: string
): string | undefined {
  const tag = version.replace(/\uFEFF/g, '').trim()
  const id = backend.replace(/\uFEFF/g, '').trim()
  const release = _memoryCache?.catalog.releases.find((r) => r.tag === tag)
  return release?.variants.find((v) => v.id === id)?.asset
}

/**
 * CUDA toolkit minor (`12.4`, `13.3`, …) for a TurboQuant Windows CUDA backend
 * id, or `null` for non-CUDA / non-Windows ids.
 */
export function getCudaToolkitVersion(backend: string): string | null {
  const match = TQ_WINDOWS_CUDA_BACKEND_RE.exec(
    backend.replace(/\uFEFF/g, '').trim()
  )
  return match ? match[1] : null
}

/** Upstream provider id for the same CUDA minor: `win-cuda-13.3-x64`. */
export function upstreamCudaBackendId(toolkitVersion: string): string {
  return `win-cuda-${toolkitVersion}-x64`
}

export function getCudartArchiveName(backend: string): string | null {
  const toolkitVersion = getCudaToolkitVersion(backend)
  if (!toolkitVersion) return null
  return `cudart-llama-bin-win-cuda-${toolkitVersion}-x64.zip`
}

/**
 * ggml-org companion URL for a TurboQuant Windows CUDA backend. Uses the
 * pinned upstream tag (not the turboquant release tag — those zips live on a
 * different CDN and do not host cudart companions).
 */
export function getCudartDownloadUrl(
  backend: string,
  ggmlOrgTag: string = GGML_ORG_CUDART_PINNED_TAG
): string | null {
  const filename = getCudartArchiveName(backend)
  if (!filename) return null
  const tag = ggmlOrgTag.replace(/\uFEFF/g, '').trim()
  if (!tag) return null
  return `${GGML_ORG_CUDART_DOWNLOAD_BASE}/${tag}/${filename}`
}

/**
 * Walk llamacpp-upstream/backends/<tag>/win-cuda-{minor}-x64/build/bin and
 * return the first bin directory that contains the expected cudart DLL.
 */
export async function findUpstreamCudaBinWithCudart(
  janDataFolderPath: string,
  toolkitVersion: string
): Promise<string | null> {
  const major = toolkitVersion.split('.')[0] ?? ''
  const cudartName =
    major === '12'
      ? 'cudart64_12.dll'
      : major === '13'
        ? 'cudart64_13.dll'
        : major === '11'
          ? 'cudart64_110.dll'
          : null
  if (!cudartName) return null

  const upstreamRoot = await joinPath([
    janDataFolderPath,
    'llamacpp-upstream',
    'backends',
  ])
  if (!(await fs.existsSync(upstreamRoot))) return null

  const upstreamBackendId = upstreamCudaBackendId(toolkitVersion)
  const versionEntries = (await fs.readdirSync(upstreamRoot)) as string[]
  // Prefer newer install folders first (lexicographic on full path is fine —
  // ggml-org tags like b9937 > b9691).
  const sorted = [...versionEntries].sort().reverse()
  for (const versionPath of sorted) {
    const binDir = await joinPath([
      versionPath,
      upstreamBackendId,
      'build',
      'bin',
    ])
    const cudartPath = await joinPath([binDir, cudartName])
    if (await fs.existsSync(cudartPath)) {
      return binDir
    }
  }
  return null
}

export async function listSupportedBackends(
  options: { force?: boolean } = {}
): Promise<BackendVersion[]> {
  const sysInfo = await getSystemInfo()
  const osType = sysInfo.os_type
  const arch = sysInfo.cpu.arch

  console.info('[listSupportedBackends] sysInfo:', osType, arch)

  const rawFeatures = await _getSupportedFeatures()
  const features = normalizeFeatures(rawFeatures)

  const supportedBackends = await determineSupportedBackends(
    osType,
    arch,
    features
  )
  console.info('[listSupportedBackends] supportedBackends:', supportedBackends)

  const [localBackendVersions, remoteBackendVersions] = await Promise.all([
    getLocalInstalledBackends(),
    fetchRemoteBackends(options),
  ])
  console.info(
    '[listSupportedBackends] local backends:',
    localBackendVersions.length,
    localBackendVersions
  )
  console.info(
    '[listSupportedBackends] remote backends:',
    remoteBackendVersions.length,
    remoteBackendVersions.map((b) => `${b.version}/${b.backend}`)
  )

  const mergedBackends = await listSupportedBackendsFromRust(
    remoteBackendVersions,
    localBackendVersions
  )

  // Every platform is gated by the same hardware matrix. On macOS that matrix
  // is the single `macos-arm64` id, so the filter is a no-op for well-formed
  // installs while still keeping a foreign build (e.g. an upstream one that
  // landed in this tree) out of the list.
  const supportedSet = new Set(supportedBackends)
  const filteredBackends = await Promise.all(
    mergedBackends.map(async (backendInfo) => ({
      backendInfo,
      normalizedBackend: await mapOldBackendToNew(backendInfo.backend),
    }))
  )

  const supportedMergedBackends = filteredBackends
    .filter(({ normalizedBackend }) => supportedSet.has(normalizedBackend))
    .map(({ backendInfo }) => backendInfo)

  console.info(
    `[listSupportedBackends] ${osType} filtered backends:`,
    supportedMergedBackends.length,
    supportedMergedBackends.map((b) => `${b.version}/${b.backend}`)
  )

  return supportedMergedBackends
}

export async function getBackendDir(
  backend: string,
  version: string
): Promise<string> {
  const janDataFolderPath = await getJanDataFolderPath()
  const backendDir = await joinPath([
    janDataFolderPath,
    'llamacpp',
    'backends',
    version.replace(/\uFEFF/g, '').trim(),
    backend.replace(/\uFEFF/g, '').trim(),
  ])
  return backendDir
}

export async function getBackendExePath(
  backend: string,
  version: string
): Promise<string> {
  const exe_name = IS_WINDOWS ? 'llama-server.exe' : 'llama-server'
  const backendDir = await getBackendDir(backend, version)
  let exePath: string
  const buildDir = await joinPath([backendDir, 'build'])
  if (await fs.existsSync(buildDir)) {
    exePath = await joinPath([backendDir, 'build', 'bin', exe_name])
  } else {
    exePath = await joinPath([backendDir, exe_name])
  }
  return exePath
}

/**
 * Windows-only defense-in-depth: a correctly packaged TurboQuant Windows
 * backend ships `llama-server.exe` alongside its dependency DLLs
 * (`llama-server-impl.dll`, `ggml*.dll`, …) extracted into the same
 * `build/bin` directory. A CI packaging regression could relocate the exe
 * without its DLLs, leaving a directory that looks "installed" (the exe
 * exists) but crashes on load with a missing-DLL error
 * ([LLAMA_CPP_PROCESS_ERROR]). Detect that shape generically — without
 * hardcoding DLL names, which vary per backend variant (CPU/CUDA/Vulkan) —
 * by requiring at least one `.dll` sibling next to the exe. Missing CUDA
 * *runtime* DLLs (cudart/cublas) are repaired separately by
 * `ensureCudartReady` and are not required for this presence check.
 */
async function windowsBackendHasDlls(exePath: string): Promise<boolean> {
  const lastSlash = Math.max(
    exePath.lastIndexOf('/'),
    exePath.lastIndexOf('\\')
  )
  if (lastSlash === -1) return false
  const exeDir = exePath.slice(0, lastSlash)
  try {
    const entries = (await fs.readdirSync(exeDir)) as string[]
    return entries.some((name) => name.toLowerCase().endsWith('.dll'))
  } catch (err) {
    // Unable to enumerate the directory - don't block installation
    // detection on an unrelated filesystem quirk we can't diagnose here;
    // the exe-existence check above remains authoritative in that case.
    console.warn(
      `[isBackendInstalled] Failed to check for DLLs in ${exeDir}:`,
      err
    )
    return true
  }
}

export async function isBackendInstalled(
  backend: string,
  version: string
): Promise<boolean> {
  const exePath = await getBackendExePath(backend, version)
  const result = await fs.existsSync(exePath)
  if (!result) return false
  if (IS_WINDOWS && !(await windowsBackendHasDlls(exePath))) {
    console.warn(
      `[isBackendInstalled] ${backend}/${version}: exe found but no DLLs alongside it - treating as not installed`
    )
    return false
  }
  return true
}

async function _getSupportedFeatures() {
  const sysInfo = await getSystemInfo()
  return await getSupportedFeaturesFromRust(
    sysInfo.os_type,
    sysInfo.cpu.extensions,
    sysInfo.gpus
  )
}
