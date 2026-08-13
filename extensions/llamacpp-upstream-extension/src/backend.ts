import { getJanDataFolderPath, fs, joinPath } from '@janhq/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { BUNDLED_MANIFEST_BASELINE } from './bundledManifestBaseline'
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
  fetchManifestHttp1,
} from '../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/index'

// Upstream provider points at the official ggml-org/llama.cpp release stream.
// Note: this is intentionally NOT janhq/llama.cpp (legacy fork mirror) and
// NOT AtomicBot-ai/atomic-llama-cpp-turboquant (our TurboQuant fork).
//
// The backend *index* (what builds exist) is resolved from a static manifest
// in our atomic-chat-conf repo, served via raw.githubusercontent.com (no
// per-IP rate limit). This dodges GitHub's unauthenticated API limit
// (60 req/hr/IP) that dead-ended fresh installs on shared/NAT/VPN networks
// (ATO-199). The manifest mirrors the GitHub release shape
// ({ tag_name, assets: [{ name }] }) so the parser below is unchanged.
//
// The *archives* come from wherever the manifest's `download_base` points —
// normally our own signed mirror in atomic-chat-conf, whose Windows binaries
// are Authenticode-signed and whose macOS binaries carry a Developer ID
// signature. A tag we have not mirrored carries no `download_base` and falls
// back to the ggml-org CDN below, so a broken mirror degrades to the old
// behaviour instead of blocking engine updates.
const LLAMACPP_BACKEND_MANIFEST_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/manifest.json'
const GGML_ORG_DOWNLOAD_BASE =
  'https://github.com/ggml-org/llama.cpp/releases/download'
const MANIFEST_FETCH_TIMEOUT_MS = 8_000

export interface UpstreamManifestAsset {
  name: string
  /** Present only on assets our mirror actually hosts. */
  sha256?: string
  size?: number
}

export interface UpstreamManifest {
  tag_name: string
  /** Absent for tags that were never mirrored; see GGML_ORG_DOWNLOAD_BASE. */
  download_base?: string
  assets: UpstreamManifestAsset[]
}

/** Where a backend archive is fetched from, and what it must hash to. */
export interface BackendArchiveSource {
  url: string
  sha256?: string
  size?: number
}
// Tag of the bundled offline baseline. It is NOT a pin: a live manifest
// carrying a newer tag is followed as-is, which is what lets an upstream
// engine update reach users without an app release. Derived from the generated
// baseline so there is no second place to keep in step with the manifest.
export const BUNDLED_BASELINE_TAG = BUNDLED_MANIFEST_BASELINE.tag_name

// In-memory manifest cache: populated ONLY on a genuinely successful live
// fetch, so a later transient network stall (e.g. the ATO-243 Linux h2-stall)
// can reuse the last good manifest within the same session. The bundled
// baseline is deliberately NEVER stored here — caching it would pin the
// session to a stale snapshot and keep returning it even after the network
// recovers (the ATO-243 cache-poisoning regression).
let _cachedManifest: UpstreamManifest | null = null

export async function getLocalInstalledBackends(): Promise<BackendVersion[]> {
  const janDataFolderPath = await getJanDataFolderPath()
  // Separate root from the turboquant extension to avoid stomping on each
  // other's installed backends.
  const backendDir = await joinPath([
    janDataFolderPath,
    'llamacpp-upstream',
    'backends',
  ])
  return await getLocalInstalledBackendsInternal(backendDir)
}
// folder structure
// <Jan's data folder>/llamacpp-upstream/backends/<backend_version>/<backend_type>

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
 * Mapping from internal Linux backend id → ggml-org upstream asset name
 * infix (the part between `bin-` and `.tar.gz`). Upstream calls its
 * Linux builds `ubuntu-*`; we surface them as `linux-*` to keep the
 * Rust matrix in `tauri-plugin-llamacpp-upstream` consistent and to
 * leave room for non-Ubuntu Linux variants if we ever ship them.
 *
 * Whitelist is deliberately narrow: `s390x`, `arm64`, `rocm-7.2-x64`,
 * `openvino-2026.0-x64`, and `vulkan-arm64` are dropped here. Adding
 * one is a one-line edit in this map + a feature detector in the Rust
 * `get_supported_features`.
 */
const LINUX_UPSTREAM_ASSET_BY_BACKEND: Record<string, string> = {
  'linux-cpu-x64': 'ubuntu-x64',
  'linux-vulkan-x64': 'ubuntu-vulkan-x64',
}

const LINUX_BACKEND_BY_UPSTREAM_ASSET: Record<string, string> =
  Object.fromEntries(
    Object.entries(LINUX_UPSTREAM_ASSET_BY_BACKEND).map(([k, v]) => [v, k])
  )

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

async function fetchManifestWithTimeout(useProxy: boolean): Promise<Response> {
  // Guard each request with a hard Promise timeout because some
  // `@tauri-apps/plugin-http` code paths may ignore AbortSignal under
  // certain network/proxy failures, which then lets the outer
  // `recheckOptimalBackend` 20s guard fire first and forces a false
  // detection-failed (current backend kept) even when fallback paths
  // could have succeeded.
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const request = tauriFetch(LLAMACPP_BACKEND_MANIFEST_URL, {
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

async function fetchManifestWithWebFetch(): Promise<Response> {
  const controller = new AbortController()
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  // `globalThis.fetch` (NOT bare `fetch`) is mandatory here: the production
  // rolldown build injects `fetch` -> `@tauri-apps/plugin-http`'s fetch (see
  // rolldown.config.mjs), so a bare `fetch` call would silently route through
  // plugin-http too. `globalThis.fetch` is the real WebView fetch, which the
  // registry loaders (provider-registry.ts etc.) prove resolves reliably and
  // quickly against raw.githubusercontent.com while plugin-http hangs on this
  // host. This is the primary/preferred manifest transport.
  const request = globalThis.fetch(LLAMACPP_BACKEND_MANIFEST_URL, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'atomic-chat' },
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

/**
 * Fetch the manifest via the Rust reqwest client forced to HTTP/1.1.
 *
 * This is the primary workaround for ATO-243: on Linux hosts Fastly's CDN
 * (which backs raw.githubusercontent.com) negotiates HTTP/2 with reqwest
 * but the h2 SETTINGS frame stalls indefinitely (the socket is open but
 * no data arrives). Forcing HTTP/1.1 (`http1_only` in reqwest) completely
 * bypasses the h2 negotiation and reliably succeeds on affected hosts.
 * The Rust command returns the raw JSON body as a string, which we wrap
 * into a minimal `Response`-like object for the rest of the pipeline.
 */
async function fetchManifestWithRustHttp1(): Promise<Response> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const rustFetch = fetchManifestHttp1(
    LLAMACPP_BACKEND_MANIFEST_URL,
    MANIFEST_FETCH_TIMEOUT_MS
  ).then((body) => {
    // Synthesise a Response-like object so callers can call `.json()` on it.
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  const timeout = new Promise<Response>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new Error(
          `Rust HTTP/1.1 manifest fetch timed out after ${MANIFEST_FETCH_TIMEOUT_MS}ms`
        )
      )
    }, MANIFEST_FETCH_TIMEOUT_MS + 1_000) // slight extra buffer for IPC overhead
  })
  try {
    return await Promise.race([rustFetch, timeout])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

async function fetchManifestWithFallbacks(): Promise<Response> {
  // Transport priority (ATO-243):
  //   1. Rust HTTP/1.1 (fetchManifestHttp1) — bypasses the reqwest h2-stall
  //      on Linux where Fastly's CDN hangs HTTP/2 indefinitely. This is the
  //      most reliable transport on the affected hosts.
  //   2. WebView fetch (globalThis.fetch / WebKitGTK) — may also be slow on
  //      Linux (WebKitGTK doesn't share network state with the user's browser)
  //      but is a useful cross-check for proxy setups.
  //   3-4. plugin-http tauri fetch (proxy-aware + direct) — reqwest with HTTP/2
  //      enabled; kept for air-gapped/corporate environments where the WebView
  //      is intercepted but the Rust HTTP client is allowed through. May stall
  //      on Linux (see above), so relies on the JS timeout guard.
  //
  // All run in parallel; `Promise.any` takes whichever resolves first.
  const attempts: Array<{
    label: string
    runner: () => Promise<Response>
  }> = [
    { label: 'rust-http1 fetch', runner: () => fetchManifestWithRustHttp1() },
    { label: 'webview fetch', runner: () => fetchManifestWithWebFetch() },
    {
      label: 'proxy-aware tauri fetch',
      runner: () => fetchManifestWithTimeout(true),
    },
    {
      label: 'direct tauri fetch',
      runner: () => fetchManifestWithTimeout(false),
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
      `[fetchRemoteBackends] Manifest fetch succeeded via ${winner.label}`
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
 * Parse a manifest object (as fetched from atomic-chat-conf or as the bundled
 * baseline) into `BackendVersion[]` for the given OS and architecture. Shared
 * by the live-fetch path, the in-memory cache path, and the bundled-baseline
 * path so there is a single authoritative parser.
 */
function parseManifestForPlatform(
  release: UpstreamManifest,
  osType: string,
  archSuffix: string
): BackendVersion[] {
  const tag = release.tag_name
  if (!tag) return []
  const assets = release.assets ?? []
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  if (osType === 'windows') {
    const re = new RegExp(`^llama-${escapedTag}-bin-(win-.+)\\.zip$`)
    const isAllowedWindowsBackend = (name: string): boolean =>
      name === 'win-cpu-x64' ||
      /^win-cuda-12\.\d+-x64$/.test(name) ||
      /^win-cuda-13\.\d+-x64$/.test(name) ||
      /^win-rocm-\d+\.\d+-x64$/.test(name) ||
      name === 'win-vulkan-x64'
    const backends: BackendVersion[] = []
    for (const asset of assets) {
      const match = re.exec(asset.name)
      if (!match) continue
      const backendName = match[1]
      if (!isAllowedWindowsBackend(backendName)) continue
      if (!backendName.endsWith(`-${archSuffix}`)) continue
      backends.push({ version: tag, backend: backendName, order: 0 })
    }
    return backends
  }

  if (osType === 'linux') {
    if (archSuffix !== 'x64') return []
    const re = new RegExp(`^llama-${escapedTag}-bin-(ubuntu-.+)\\.tar\\.gz$`)
    const backends: BackendVersion[] = []
    for (const asset of assets) {
      const match = re.exec(asset.name)
      if (!match) continue
      const backendName = LINUX_BACKEND_BY_UPSTREAM_ASSET[match[1]]
      if (!backendName) continue
      backends.push({ version: tag, backend: backendName, order: 0 })
    }
    return backends
  }

  if (osType === 'macos') {
    // ggml-org publishes both architectures, but the manifest carries only
    // `macos-arm64`: runtime updates on macOS are Apple Silicon only, and an
    // Intel host stays on its bundled build. macOS has no GPU tiers to choose
    // from, so `listSupportedBackends` passes this list through unfiltered —
    // the arch filter has to happen here, or an Intel host would be offered
    // the arm64 build the moment the manifest lists one.
    const re = new RegExp(`^llama-${escapedTag}-bin-(macos-.+)\\.tar\\.gz$`)
    const backends: BackendVersion[] = []
    for (const asset of assets) {
      const match = re.exec(asset.name)
      if (!match) continue
      const backendName = match[1]
      if (backendName !== `macos-${archSuffix}`) continue
      backends.push({ version: tag, backend: backendName, order: 0 })
    }
    return backends
  }

  return []
}

/**
 * Fetches the list of available backend builds from ggml-org/llama.cpp
 * GitHub releases for the current platform/arch.
 *
 * macOS: returns the `macos-arm64` asset on Apple Silicon, so a new engine
 * build reaches those users without an app release, and nothing on Intel,
 * which stays on its bundled build. The bundled build is also the offline
 * baseline everywhere. See the 2026-08-12 ADR *Update upstream llama.cpp at
 * runtime on macOS too*, which supersedes the bundle-only clause of the
 * 2026-05-19 macOS ADR.
 *
 * Windows: returns the ggml-org Windows assets (CPU / CUDA 12.x / CUDA 13.x
 * / Vulkan) so the runtime update flow can fetch fresh builds without
 * shipping a new installer.
 *
 * Linux: returns the ggml-org Ubuntu assets (CPU + Vulkan, x64 only) so
 * the runtime update flow can fetch fresh builds. See the 2026-05-28 ADR
 * *Linux ships only `llamacpp-upstream`*.
 *
 * Returns `[]` on network failure so the app can still work offline with
 * only bundled/local backends.
 */
export async function fetchRemoteBackends(options?: {
  force?: boolean
}): Promise<BackendVersion[]> {
  const sysInfo = await getSystemInfo()
  const osType = sysInfo.os_type
  const arch = sysInfo.cpu.arch

  if (osType !== 'windows' && osType !== 'linux' && osType !== 'macos') {
    return []
  }

  const archSuffix =
    arch.includes('aarch64') || arch.includes('arm64') ? 'arm64' : 'x64'

  // --- In-memory cache check -------------------------------------------------
  // If we've already fetched a LIVE manifest this session, return it
  // immediately. This avoids repeated network round-trips. Only successful
  // live fetches land here (see assignment below); the bundled baseline is
  // never cached, so a transient failure does not pin subsequent calls to a
  // stale snapshot once the network recovers.
  // `force` is the explicit "check for engine updates" path: a release
  // published while the app was open is invisible to a session-cached
  // manifest, which is exactly what the button exists to defeat.
  if (options?.force) {
    _cachedManifest = null
  } else if (_cachedManifest) {
    console.info('[fetchRemoteBackends] Using in-memory manifest cache')
    return parseManifestForPlatform(_cachedManifest, osType, archSuffix)
  }

  const live = await fetchLiveManifest()
  if (!live) {
    return parseManifestForPlatform(
      BUNDLED_MANIFEST_BASELINE,
      osType,
      archSuffix
    )
  }

  const backends = parseManifestForPlatform(live, osType, archSuffix)
  console.info(
    `[fetchRemoteBackends] Found ${backends.length} remote backends for ${osType}-${archSuffix}:`,
    backends.map((b) => b.backend)
  )
  return backends
}

/**
 * Fetches the live manifest and caches it for the session, or returns `null`
 * when it could not be obtained. Callers fall back to
 * `BUNDLED_MANIFEST_BASELINE` themselves, which keeps the ATO-243 invariant
 * visible at the call site: the baseline is never written to `_cachedManifest`.
 */
async function fetchLiveManifest(): Promise<UpstreamManifest | null> {
  try {
    console.info(
      `[fetchRemoteBackends] Fetching ${LLAMACPP_BACKEND_MANIFEST_URL}...`
    )
    const resp = await fetchManifestWithFallbacks()
    if (!resp.ok) {
      console.warn(
        `[fetchRemoteBackends] Backend manifest returned ${resp.status}; using bundled baseline (not cached, will retry next call)`
      )
      return null
    }

    const release: UpstreamManifest = await resp.json()
    const tag = release.tag_name
    if (!tag) {
      console.warn(
        '[fetchRemoteBackends] Manifest missing tag_name; using bundled baseline (not cached, will retry next call)'
      )
      return null
    }
    // The manifest tag is authoritative. `atomic-chat-conf` is ours and the
    // tag only moves once a build has been mirrored and signed there, so
    // requiring it to equal the compiled-in baseline would mean no upstream
    // engine update can ever reach a user without an app release — the opposite
    // of what the "check for engine updates" button promises.
    if (tag !== BUNDLED_BASELINE_TAG) {
      console.info(
        `[fetchRemoteBackends] Manifest tag ${tag} differs from the bundled baseline ${BUNDLED_BASELINE_TAG}; following the manifest`
      )
    }

    // Cache ONLY a genuinely successful live manifest for this session. The
    // bundled baseline is never stored here (see _cachedManifest comment).
    _cachedManifest = release
    return release
  } catch (err) {
    // All transports failed. Log the real cause (each per-transport reason is
    // embedded in the AggregateError message from fetchManifestWithFallbacks),
    // then let the caller fall back to the bundled baseline so the user can
    // still download GPU backends. The baseline may be one release behind, but
    // it is always better than a dead-end. It is deliberately NOT cached, so
    // the next call retries the network and self-heals once the stall clears.
    console.warn(
      '[fetchRemoteBackends] All manifest fetch transports failed; falling back to bundled baseline (not cached, will retry next call).',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

/**
 * Resolves where a backend archive should be downloaded from and what it must
 * hash to.
 *
 * The manifest's `download_base` (our signed mirror) is used only when the
 * manifest describes *this exact tag* and lists *this exact asset* with a
 * hash. Anything else — an older tag the user is reinstalling, a tag we never
 * mirrored, an unreachable manifest — resolves to the ggml-org CDN without a
 * hash, which is what the client did before the mirror existed.
 */
export async function resolveBackendArchiveSource(
  version: string,
  backend: string
): Promise<BackendArchiveSource> {
  const cleanVersion = version.replace(/\uFEFF/g, '').trim()
  const archiveName = getBackendArchiveName(cleanVersion, backend)
  const fallback = {
    url: `${GGML_ORG_DOWNLOAD_BASE}/${cleanVersion}/${archiveName}`,
  }

  const manifest = _cachedManifest ?? (await fetchLiveManifest())
  if (!manifest || manifest.tag_name !== cleanVersion) return fallback
  if (!manifest.download_base) return fallback

  const asset = (manifest.assets ?? []).find((a) => a.name === archiveName)
  if (!asset?.sha256 || !asset.size) {
    console.info(
      `[resolveBackendArchiveSource] ${archiveName} is not mirrored for ${cleanVersion}; using the upstream CDN`
    )
    return fallback
  }

  return {
    url: `${manifest.download_base}/${cleanVersion}/${archiveName}`,
    sha256: asset.sha256,
    size: asset.size,
  }
}

/**
 * Builds the download URL for a specific backend version on the ggml-org CDN.
 *
 * This is the un-mirrored fallback shape. Download paths should call
 * `resolveBackendArchiveSource`, which prefers our signed mirror and returns
 * the hash to verify; this function stays for callers that only need a URL.
 *
 * Asset naming differs by platform:
 *   - macOS: `llama-{tag}-bin-macos-{arm64,x64}.tar.gz`
 *   - Windows: `llama-{tag}-bin-win-{variant}.zip`
 *   - Linux: `llama-{tag}-bin-ubuntu-{variant}.tar.gz` (note: internal
 *     backend ids are `linux-*` but upstream filenames carry `ubuntu-*`;
 *     `LINUX_UPSTREAM_ASSET_BY_BACKEND` provides the mapping).
 *
 * macOS / Linux use `.tar.gz`, Windows uses `.zip`. The Tauri `decompress`
 * command handles both formats transparently.
 */
export function getBackendDownloadUrl(
  version: string,
  backend: string
): string {
  version = version.replace(/\uFEFF/g, '').trim()
  backend = backend.replace(/\uFEFF/g, '').trim()
  // Defense-in-depth (ATO-95): ggml-org tags releases as `bXXXX`. The
  // `latest` keyword is only valid for the `/releases/latest` HTML page,
  // NOT for the `/releases/download/<tag>/...` asset path. A literal
  // `latest` here means an unresolved sentinel leaked through — fail loudly
  // instead of silently building a guaranteed-404 URL.
  if (version === 'latest') {
    throw new Error(
      `getBackendDownloadUrl: unresolved 'latest' tag for backend '${backend}'. The latest/<backend> sentinel must be resolved to a concrete release tag before download.`
    )
  }
  const archiveName = getBackendArchiveName(version, backend)
  return `${GGML_ORG_DOWNLOAD_BASE}/${version}/${archiveName}`
}

export function getBackendArchiveName(
  version: string,
  backend: string
): string {
  version = version.replace(/\uFEFF/g, '').trim()
  backend = backend.replace(/\uFEFF/g, '').trim()
  const linuxInfix = LINUX_UPSTREAM_ASSET_BY_BACKEND[backend]
  if (linuxInfix) {
    return `llama-${version}-bin-${linuxInfix}.tar.gz`
  }
  const extension = backend.startsWith('macos-') ? 'tar.gz' : 'zip'
  return `llama-${version}-bin-${backend}.${extension}`
}

/**
 * Maps an internal backend id (e.g. `win-cuda-13.4-x64`, `linux-vulkan-x64`)
 * to a short human-friendly variant label used by the "Latest <variant>"
 * dropdown entries. Falls back to the raw id for anything unrecognised.
 */
export function friendlyBackendLabel(backend: string): string {
  const id = backend.replace(/\uFEFF/g, '').trim()
  if (id.endsWith('cpu-x64')) return 'CPU'
  if (id.includes('cuda-13')) return 'CUDA 13'
  if (id.includes('cuda-12')) return 'CUDA 12'
  if (id.includes('rocm')) {
    // The version-less family id (`win-rocm-x64`) has nothing to append; a
    // concrete asset carries the HIP version worth showing.
    const version = /rocm-(\d+\.\d+)/.exec(id)?.[1]
    return version ? `ROCm ${version} (~1 GB)` : 'ROCm (~1 GB)'
  }
  if (id.includes('vulkan')) return 'Vulkan'
  if (id === 'macos-arm64') return 'Apple Silicon'
  if (id === 'macos-x64') return 'Intel'
  return id
}

/// Unpacked size of the Windows HIP tree, measured from the b10405 archive's
/// zip central directory: ~980 MB, of which `ggml-hip.dll` alone is 924 MB
/// because the whole HIP runtime is linked into it. By far the largest backend
/// in the product, and the reason a free-space precondition exists at all.
const WIN_ROCM_UNPACKED_BYTES = 980 * 1024 * 1024
/// Headroom over archive + unpacked so the check does not green-light an
/// install that lands the volume at zero free bytes.
const BACKEND_INSTALL_HEADROOM_BYTES = 200 * 1024 * 1024
/// Used when the manifest carries no size for the archive (an unmirrored tag).
/// Measured at 196.6 MB for `win-rocm-7.14-x64` in b10405.
const WIN_ROCM_ARCHIVE_BYTES_FALLBACK = 200 * 1024 * 1024

/**
 * Bytes that must be free before downloading `backend`, or `null` when the
 * backend is small enough that no precondition is warranted (every non-HIP
 * upstream archive unpacks to well under 300 MB).
 *
 * The archive is counted alongside the unpacked tree because it stays in the
 * staging directory until extraction finishes.
 */
export function requiredDiskSpaceForBackend(
  backend: string,
  archiveBytes?: number
): number | null {
  const id = backend.replace(/\uFEFF/g, '').trim()
  if (!id.includes('rocm')) return null
  const archive =
    archiveBytes && archiveBytes > 0
      ? archiveBytes
      : WIN_ROCM_ARCHIVE_BYTES_FALLBACK
  return archive + WIN_ROCM_UNPACKED_BYTES + BACKEND_INSTALL_HEADROOM_BYTES
}

/**
 * Maps a Windows CUDA backend variant id (e.g. `win-cuda-13.4-x64`) to
 * the matching cudart asset on the same ggml-org/llama.cpp release.
 *
 * The main `llama-{tag}-bin-win-cuda-{12.4,13.x}-x64.zip` archives ship
 * only the llama-server executable and its direct deps; the CUDA Toolkit
 * runtime DLLs (cudart64_*.dll, cublas64_*.dll, cublasLt64_*.dll, …)
 * live in a sibling `cudart-llama-bin-win-cuda-{12.4,13.x}-x64.zip`.
 * Without those DLLs, `llama-server.exe --list-devices` returns an empty
 * device list on machines that don't have the CUDA Toolkit installed
 * system-wide (GitHub issue AtomicBot-ai/Atomic-Chat#14).
 *
 * ggml-org dropped CUDA 11 release artifacts — the lowest CUDA tier
 * shipped is CUDA 12.4. Hosts whose driver only supports CUDA 11 fall
 * back to the CPU build via runtime driver-version gating.
 *
 * These companions are deliberately NOT mirrored: the DLLs inside are
 * NVIDIA's own and already signed by NVIDIA, and at ~391 MB each they would
 * triple the size of every mirrored tag. They keep resolving to the ggml-org
 * CDN even when the backend archive itself comes from our mirror.
 */
const WINDOWS_CUDA_BACKEND_RE = /^win-cuda-(12\.\d+|13\.\d+)-x64$/

function matchWindowsCudaBackend(backend: string): string | null {
  const match = WINDOWS_CUDA_BACKEND_RE.exec(
    backend.replace(/\uFEFF/g, '').trim()
  )
  if (!match) return null
  return match[1]
}

function buildWindowsCudartArchiveName(cudaToolkitVersion: string): string {
  return `cudart-llama-bin-win-cuda-${cudaToolkitVersion}-x64.zip`
}

/**
 * Returns the download URL for the cudart companion archive that must be
 * merged into `<backendDir>/build/bin/` for a Windows CUDA backend, or
 * `null` if `backend` is not one of the Windows CUDA variants.
 */
export function getCudartDownloadUrl(
  version: string,
  backend: string
): string | null {
  const toolkitVersion = matchWindowsCudaBackend(backend)
  if (!toolkitVersion) return null
  const filename = buildWindowsCudartArchiveName(toolkitVersion)
  const cleanVersion = version.replace(/\uFEFF/g, '').trim()
  return `${GGML_ORG_DOWNLOAD_BASE}/${cleanVersion}/${filename}`
}

/**
 * Returns the cudart filename (without URL) for a Windows CUDA backend,
 * or `null` if the backend is not a Windows CUDA variant.
 */
export function getCudartArchiveName(backend: string): string | null {
  const toolkitVersion = matchWindowsCudaBackend(backend)
  if (!toolkitVersion) return null
  return buildWindowsCudartArchiveName(toolkitVersion)
}

/**
 * Returns the CUDA Toolkit version string (e.g. `13.3`) that the Rust
 * `is_cuda_installed` command expects for a given Windows CUDA backend.
 * `null` for non-CUDA backends.
 */
export function getCudaToolkitVersion(backend: string): string | null {
  return matchWindowsCudaBackend(backend)
}

/**
 * Matches a *minor-less* Windows CUDA family id (e.g. `win-cuda-13-x64`,
 * `win-cuda-12-x64`). These are the family ids the Rust matrix
 * (`determine_supported_backends`) and the TS dropdown `staticVariants`
 * emit — the concrete minor (`13.3`, `12.4`) is only known once the
 * ggml-org release stream is queried (ATO-105/ATO-174).
 */
const WIN_CUDA_FAMILY_RE = /^win-cuda-(\d+)-x64$/

/**
 * The ROCm equivalent. HIP has no major to pin at all: upstream publishes a
 * single `win-rocm-<major>.<minor>-x64` asset per release and moves that
 * version wholesale (7.14 today), so the family id carries no version and the
 * concrete one always comes from the manifest.
 */
const WIN_ROCM_FAMILY_ID = 'win-rocm-x64'
const WIN_ROCM_CONCRETE_RE = /^win-rocm-(\d+)\.(\d+)-x64$/

/**
 * The CUDA major (`"13"`, `"12"`) of a minor-less family id, or `null` if
 * `backend` is not a minor-less Windows CUDA family id (concrete ids like
 * `win-cuda-13.3-x64` deliberately return `null` here — they need no
 * family resolution).
 */
export function cudaFamilyMajor(backend: string): string | null {
  const m = WIN_CUDA_FAMILY_RE.exec(backend.replace(/\uFEFF/g, '').trim())
  return m ? m[1] : null
}

/**
 * Regex matching every concrete asset id of a version-less GPU family id, with
 * the version components captured so the newest can be picked. `null` when
 * `familyBackend` is not a family id.
 */
function gpuFamilyConcreteRe(familyBackend: string): RegExp | null {
  const id = familyBackend.replace(/\uFEFF/g, '').trim()
  if (id === WIN_ROCM_FAMILY_ID) return WIN_ROCM_CONCRETE_RE
  const major = cudaFamilyMajor(id)
  return major ? new RegExp(`^win-cuda-(${major})\\.(\\d+)-x64$`) : null
}

/**
 * True when `concrete` (e.g. `win-cuda-13.3-x64`, `win-rocm-7.14-x64`) belongs
 * to the version-less GPU family `familyBackend` (`win-cuda-13-x64`,
 * `win-rocm-x64`). False for a non-family `familyBackend` or a non-matching
 * major.
 */
export function isConcreteOfGpuFamily(
  familyBackend: string,
  concrete: string
): boolean {
  const concreteRe = gpuFamilyConcreteRe(familyBackend)
  if (!concreteRe) return false
  return concreteRe.test(concrete.replace(/\uFEFF/g, '').trim())
}

/**
 * Resolves a version-less GPU family id (`win-cuda-13-x64`, `win-rocm-x64`) to
 * the newest concrete `<tag>/<backend>` of that family in `remote` (e.g.
 * `b9596/win-cuda-13.3-x64`, `b10405/win-rocm-7.14-x64`). Picks the highest
 * version when upstream ships more than one. Returns `null` when
 * `familyBackend` is not a family id or no concrete asset is present.
 */
export function resolveGpuFamilyConcrete(
  familyBackend: string,
  remote: BackendVersion[]
): string | null {
  const concreteRe = gpuFamilyConcreteRe(familyBackend)
  if (!concreteRe) return null
  let best: {
    version: string
    backend: string
    rank: [number, number]
  } | null = null
  for (const b of remote) {
    const backendName = b.backend.replace(/\uFEFF/g, '').trim()
    const m = concreteRe.exec(backendName)
    if (!m) continue
    const rank: [number, number] = [parseInt(m[1], 10), parseInt(m[2], 10)]
    if (
      !best ||
      rank[0] > best.rank[0] ||
      (rank[0] === best.rank[0] && rank[1] > best.rank[1])
    ) {
      best = { version: b.version, backend: backendName, rank }
    }
  }
  return best ? `${best.version}/${best.backend}` : null
}

export async function listSupportedBackends(options?: {
  force?: boolean
}): Promise<BackendVersion[]> {
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

  // Hardware-gated backend matrix applies on Windows: the user only sees
  // backends whose driver/Vulkan/CUDA requirements are actually met on
  // this host. macOS keeps the merged list unfiltered (every ggml-org
  // macOS asset is supported on the matching arch).
  if (osType !== 'windows') {
    void supportedBackends
    void mapOldBackendToNew
    return mergedBackends
  }

  const supportedSet = new Set(supportedBackends)
  // CUDA-13 is matched family-wise (ATO-105): ggml-org periodically bumps
  // the toolkit minor (13.1 -> 13.3 -> 13.x) in its release assets, so the
  // supported set carries the minor-less family id `win-cuda-13-x64` (emitted
  // by `determine_supported_backends`) instead of a hardcoded concrete minor.
  // Any concrete `win-cuda-13.<minor>-x64` asset is accepted when the family
  // is supported, and the concrete id (e.g. `win-cuda-13.4-x64`) keeps
  // flowing downstream unchanged so the right asset is downloaded.
  // ROCm rides the same mechanism through the version-less `win-rocm-x64`
  // family id, since upstream moves its HIP version too (7.14 today).
  const WIN_CUDA13_CONCRETE_RE = /^win-cuda-13\.\d+-(x64|arm64)$/
  const isSupported = (
    rawBackend: string,
    normalizedBackend: string
  ): boolean => {
    if (supportedSet.has(normalizedBackend)) return true
    const m = WIN_CUDA13_CONCRETE_RE.exec(rawBackend)
    if (m) {
      return supportedSet.has(`win-cuda-13-${m[1]}`)
    }
    if (isConcreteOfGpuFamily(WIN_ROCM_FAMILY_ID, rawBackend)) {
      return supportedSet.has(WIN_ROCM_FAMILY_ID)
    }
    return false
  }

  const filteredBackends = await Promise.all(
    mergedBackends.map(async (backendInfo) => ({
      backendInfo,
      rawBackend: backendInfo.backend.replace(/\uFEFF/g, '').trim(),
      normalizedBackend: await mapOldBackendToNew(backendInfo.backend),
    }))
  )

  const supportedMergedBackends = filteredBackends
    .filter(({ rawBackend, normalizedBackend }) =>
      isSupported(rawBackend, normalizedBackend)
    )
    .map(({ backendInfo }) => backendInfo)

  console.info(
    '[listSupportedBackends] windows filtered backends:',
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
    'llamacpp-upstream',
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

export async function isBackendInstalled(
  backend: string,
  version: string
): Promise<boolean> {
  const exePath = await getBackendExePath(backend, version)
  const result = await fs.existsSync(exePath)
  return result
}

/**
 * Compute the set of backend type strings that are equivalent to `backendType`
 * for the purpose of compatibility checking (ATO-233). In particular, ggml-org
 * Linux tarballs carry `ubuntu-*` asset names (e.g. `ubuntu-vulkan-x64`), but
 * the extension stores backends under `linux-*` internal ids
 * (`linux-vulkan-x64`). Backends installed via "Install Backend from File"
 * with an unpatched version of the app may therefore be on disk under the
 * ubuntu name. This helper returns ALL names that should be treated as the
 * same type so `findCompatibleInstalledBackend` can find them.
 */
function backendTypeEquivalents(backendType: string): Set<string> {
  const ids = new Set<string>()
  const bt = backendType.replace(/\uFEFF/g, '').trim()
  ids.add(bt)
  // linux-vulkan-x64 ↔ ubuntu-vulkan-x64
  if (bt === 'linux-vulkan-x64') ids.add('ubuntu-vulkan-x64')
  if (bt === 'linux-vulkan-arm64') ids.add('ubuntu-vulkan-arm64')
  if (bt === 'linux-cpu-x64') ids.add('ubuntu-x64')
  if (bt === 'linux-cpu-arm64') ids.add('ubuntu-arm64')
  // Reverse mappings: when the on-disk name is the ubuntu variant
  if (bt === 'ubuntu-vulkan-x64') ids.add('linux-vulkan-x64')
  if (bt === 'ubuntu-vulkan-arm64') ids.add('linux-vulkan-arm64')
  if (bt === 'ubuntu-x64') ids.add('linux-cpu-x64')
  if (bt === 'ubuntu-arm64') ids.add('linux-cpu-arm64')
  return ids
}

/**
 * Find a working, already-installed backend of the SAME type as `backendType`
 * (e.g. `macos-arm64`), regardless of its release tag. Used as a fallback
 * (ATO-179, AC2) when the model's pinned `version_backend` can't be obtained
 * (download failed / the tag was pruned upstream) but a compatible build is
 * already on disk — so the load degrades to a working backend instead of
 * failing with `BINARY_NOT_FOUND`.
 *
 * "Compatible" is deliberately limited to the identical backend type: every
 * release tag of the same type targets the same platform / GPU variant and is
 * interchangeable. We do NOT cross types here (e.g. cuda → cpu) — that is a
 * feature/perf trade-off that must stay an explicit user choice.
 *
 * ATO-233: also recognises `ubuntu-*` ↔ `linux-*` name equivalents so that
 * backends installed via "Install Backend from File" with ggml-org upstream
 * tarball names are found even if the on-disk directory still uses the old
 * ubuntu name.
 *
 * Returns the newest (by on-disk mtime, via `order`) matching backend, or
 * `null` when none is installed.
 */
export async function findCompatibleInstalledBackend(
  backendType: string
): Promise<BackendVersion | null> {
  const equivalents = backendTypeEquivalents(backendType)
  const installed = await getLocalInstalledBackends()
  const sameType = installed.filter((b) =>
    equivalents.has(b.backend.replace(/\uFEFF/g, '').trim())
  )
  if (sameType.length === 0) return null
  sameType.sort((a, b) => (b.order ?? 0) - (a.order ?? 0))
  return sameType[0]
}

/**
 * Remove orphan / incomplete backend directories from this provider's
 * backends tree (ATO-179, AC3). An "incomplete" directory is one that exists
 * on disk but carries no `llama-server` executable — e.g. an empty stub left
 * by an interrupted/failed download, which would otherwise be mistaken for a
 * usable backend or block a clean re-download.
 *
 * Scoped strictly to `llamacpp-upstream/backends/` so the shared GGUF model
 * tree and the turboquant `llamacpp` backends are never touched. Best-effort:
 * a failure on any single entry is logged by the caller and does not abort the
 * sweep. Returns the list of removed `<version>/<backend>` identifiers.
 */
export async function cleanupIncompleteBackends(): Promise<string[]> {
  const janDataFolderPath = await getJanDataFolderPath()
  const backendsRoot = await joinPath([
    janDataFolderPath,
    'llamacpp-upstream',
    'backends',
  ])

  const removed: string[] = []
  if (!(await fs.existsSync(backendsRoot))) return removed

  const versionDirs: string[] = await fs.readdirSync(backendsRoot)
  for (const version of versionDirs) {
    const versionPath = await joinPath([backendsRoot, version])
    let backendTypes: string[]
    try {
      backendTypes = await fs.readdirSync(versionPath)
    } catch {
      // Not a directory (stray file) — skip; it does not match our layout.
      continue
    }

    for (const backendType of backendTypes) {
      if (await isBackendInstalled(backendType, version)) continue
      const dir = await getBackendDir(backendType, version)
      await fs.rm(dir)
      removed.push(`${version}/${backendType}`)
    }

    // Drop a now-empty version directory.
    try {
      const remaining: string[] = await fs.readdirSync(versionPath)
      if (remaining.length === 0) await fs.rm(versionPath)
    } catch {
      // ignore
    }
  }

  return removed
}

async function _getSupportedFeatures() {
  const sysInfo = await getSystemInfo()
  return await getSupportedFeaturesFromRust(
    sysInfo.os_type,
    sysInfo.cpu.extensions,
    sysInfo.gpus
  )
}
