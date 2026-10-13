import { getJanDataFolderPath, fs, joinPath } from '@janhq/core'
import { getVersion } from '@tauri-apps/api/app'
import { getProxyConfig } from './util'
import {
  getLocalInstalledBackendsInternal,
  BackendVersion,
} from '../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index'
import { getBackendCatalog } from './adapter/coreRuntime'
import type {
  CoreBackendCatalog,
  CoreProxyConfig,
} from './adapter/coreRuntime'

// The TurboQuant provider (this extension) points at our llama.cpp fork
// AtomicBot-ai/atomic-llama-cpp-turboquant. Since ADR 2026-09-27 the backend
// *index* — which releases exist and which variants each one carries — is
// resolved by `atomic-chat-core` (`index.json` of the latest release, the
// `/releases/latest` redirect, the legacy conf manifest, then the disk cache),
// gated on this app's version and on the hardware the core measured, and
// handed to this extension as one catalog (`loadCatalog`). Nothing here fetches
// or parses the index any more; the wrappers below keep the names the rest of
// the extension grew up with.
//
// Only stable releases of the unified `b<upstream-build>-<fork-semver>` scheme
// are installable. `dev-latest` and the legacy per-variant
// `turboquant-<id>-<sha>` releases are prereleases: they are never offered for
// download, although an already-installed legacy build keeps working.
//
// The backend *archives* themselves are downloaded by `atomic-chat-core`, under
// the asset names this index gives (`getIndexedAssetName`).

/** How long one catalog answer is reused before the core is asked again. */
const CATALOG_TTL_MS = 60 * 60 * 1000

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
    .replace(/﻿/g, '')
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
      (tag ?? '').replace(/﻿/g, '').trim()
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
  /** Newest stable tag the core accepted, or null when nothing is usable. */
  latest: string | null
  /** Stable, app-compatible releases, newest first. */
  releases: TurboquantRelease[]
  /**
   * Where the core got the index: `index`, `redirect`, `legacy-manifest`,
   * `disk-cache`, or `none` when it had nothing (or could not be reached).
   */
  source: string
}

const EMPTY_CATALOG: TurboquantCatalog = {
  latest: null,
  releases: [],
  source: 'none',
}

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

const clean = (value: string) => value.replace(/﻿/g, '').trim()

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
 * Validates a backend build for removal and returns its cleaned ids. The
 * selected build is refused rather than silently skipped: deleting it would
 * leave `version_backend` pointing at a directory that no longer exists and the
 * next model load would fail with a missing-binary error instead of anything
 * actionable. Ids carrying path separators or made of dots are refused so a
 * removal can never reach outside the pack's own directory.
 */
export function assertDeletableBackendPack(
  currentVersionBackend: string,
  version: string,
  backend: string
): { version: string; backend: string } {
  const cleanVersion = clean(version)
  const cleanBackend = clean(backend)
  if (
    !cleanVersion ||
    !cleanBackend ||
    /[/\\]/.test(cleanVersion) ||
    /[/\\]/.test(cleanBackend) ||
    /^\.+$/.test(cleanVersion) ||
    /^\.+$/.test(cleanBackend)
  ) {
    throw new Error(`Invalid backend pack: '${version}/${backend}'`)
  }
  if (`${cleanVersion}/${cleanBackend}` === clean(currentVersionBackend)) {
    throw new Error('Cannot remove the backend that is currently selected')
  }
  return { version: cleanVersion, backend: cleanBackend }
}

// ---------------------------------------------------------------------------
// The catalog, asked of the core
// ---------------------------------------------------------------------------

/**
 * Numeric semver comparison over the leading `major.minor.patch`, ignoring any
 * prerelease/build suffix. Returns <0, 0 or >0.
 */
function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/﻿/g, '')
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
 *
 * @deprecated The core applies this gate from the `app_version` that
 * `loadCatalog` passes it; the releases it returns already satisfy it.
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

export async function getAppVersion(): Promise<string | null> {
  try {
    return await getVersion()
  } catch (err) {
    console.warn('[loadCatalog] app version unavailable:', err)
    return null
  }
}

/**
 * What every advisor question carries to the core: the app version its
 * `min_app_version` gate reads, and the user's proxy for the index fetch. The
 * body travels as a POST because the proxy may carry credentials.
 */
export async function catalogRequestContext(): Promise<{
  app_version: string | null
  proxy: CoreProxyConfig | null
}> {
  return {
    app_version: await getAppVersion(),
    proxy: (getProxyConfig() as unknown as CoreProxyConfig | null) ?? null,
  }
}

let _catalog: { fetched_at: number; catalog: CoreBackendCatalog } | null = null
let _inFlight: Promise<CoreBackendCatalog> | null = null
let _forceNextLoad = false

/**
 * The backend catalog for this machine, from the core: the release index it
 * resolved, the remote and installed builds, what this hardware can run
 * (`available`) and what it should run (`recommended`). One answer is reused
 * for an hour or until something asks to `force`; concurrent callers share one
 * request. Throws when the core cannot be reached — the callers decide whether
 * that means "no catalog" (`fetchStableIndex`) or "fall back to the bundled
 * build" (`configureBackends`).
 */
export async function loadCatalog(
  options: {
    /** Ask the core to refetch the release index too (a user-driven check). */
    force?: boolean
    /**
     * Ask the core again instead of answering from this module's memo, without forcing a
     * refetch: the core rescans the packs on disk (a backend installed from a file never passes
     * through it), while its own index cache still answers the remote half.
     */
    refresh?: boolean
  } = {}
): Promise<CoreBackendCatalog> {
  const force = options.force === true || _forceNextLoad
  const fresh =
    !options.refresh &&
    _catalog !== null &&
    Date.now() - _catalog.fetched_at < CATALOG_TTL_MS
  if (!force && fresh) return _catalog!.catalog
  if (_inFlight) return _inFlight

  _inFlight = (async () => {
    const context = await catalogRequestContext()
    const catalog = await getBackendCatalog({ ...context, force })
    _catalog = { fetched_at: Date.now(), catalog }
    _forceNextLoad = false
    console.info(
      `[loadCatalog] ${catalog.available.length} installable backend(s) for this machine from ${catalog.source}, recommended ${catalog.recommended ?? '(none)'}`
    )
    return catalog
  })().finally(() => {
    _inFlight = null
  })

  return _inFlight
}

/** The last catalog `loadCatalog` returned, for synchronous readers; null while cold. */
export function catalogSnapshot(): CoreBackendCatalog | null {
  return _catalog?.catalog ?? null
}

/**
 * Makes the next `loadCatalog` ask the core with `force`, so an explicit
 * user-driven check sees releases published since the index was last cached.
 */
export function invalidateStableIndexCache(): void {
  _catalog = null
  _forceNextLoad = true
}

/**
 * The stable, app-compatible releases of the fork, newest first, as the core
 * resolved them. Never throws: an unreachable core is an empty catalog, and the
 * bundled/local backends still work.
 */
export async function fetchStableIndex(
  options: { force?: boolean } = {}
): Promise<TurboquantCatalog> {
  try {
    const catalog = await loadCatalog(options)
    const releases: TurboquantRelease[] = catalog.releases ?? []
    return {
      latest: releases[0]?.tag ?? null,
      releases,
      source: catalog.source,
    }
  } catch (err) {
    console.warn(
      '[fetchStableIndex] the core did not answer, falling back to local backends only:',
      err
    )
    return EMPTY_CATALOG
  }
}

/**
 * The archive name the fork publishes for a backend id. Windows ships `.zip`,
 * everything else `.tar.gz`. The id prefix decides, so a legacy `win-*` id
 * resolved on another host still picks the right extension; ids with no
 * platform prefix fall back to the running OS.
 */
export function defaultAssetName(backend: string): string {
  const id = backend.replace(/﻿/g, '').trim()
  const isWindowsAsset = /^win(dows)?-/.test(id)
    ? true
    : /^(linux|macos|mac)-/.test(id)
      ? false
      : IS_WINDOWS
  return `llama-turboquant-${id}.${isWindowsAsset ? 'zip' : 'tar.gz'}`
}

/**
 * The installable stable builds for this machine, as `BackendVersion[]`: the
 * core's `remote` list, already gated on OS/arch and the detected GPU tier so
 * the user never sees a variant their hardware cannot run. Returns `[]` on any
 * failure so the app still works offline with bundled/local backends only.
 */
export async function fetchRemoteBackends(
  options: { force?: boolean } = {}
): Promise<BackendVersion[]> {
  try {
    const catalog = await loadCatalog(options)
    return catalog.remote
  } catch (err) {
    console.warn('[fetchRemoteBackends] the core did not answer:', err)
    return []
  }
}

/**
 * The published asset name for `tag/backend`, read from the last catalog the
 * core returned. Returns `undefined` when no catalog has been loaded yet or it
 * does not describe this pair, leaving the caller on the naming convention.
 */
export function getIndexedAssetName(
  version: string,
  backend: string
): string | undefined {
  const tag = version.replace(/﻿/g, '').trim()
  const id = backend.replace(/﻿/g, '').trim()
  const release = catalogSnapshot()?.releases?.find((r) => r.tag === tag)
  return release?.variants.find((v) => v.id === id)?.asset
}

/**
 * The builds this machine can run — remote releases merged with what is on
 * disk, filtered by the hardware the core measured and sorted — as the core's
 * `available` list. Throws when the core cannot be reached, so
 * `configureBackends` can fall back to the bundled build.
 */
export async function listSupportedBackends(
  options: { force?: boolean } = {}
): Promise<BackendVersion[]> {
  const catalog = await loadCatalog(options)
  console.info(
    `[listSupportedBackends] ${catalog.os_type} filtered backends:`,
    catalog.available.length,
    catalog.available.map((b) => `${b.version}/${b.backend}`)
  )
  return catalog.available
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
    version.replace(/﻿/g, '').trim(),
    backend.replace(/﻿/g, '').trim(),
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
 * *runtime* DLLs (cudart/cublas) are repaired separately by the core and are
 * not required for this presence check.
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
