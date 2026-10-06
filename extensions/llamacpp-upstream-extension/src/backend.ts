import { getJanDataFolderPath, fs, joinPath } from '@janhq/core'
import { BUNDLED_MANIFEST_BASELINE } from './bundledManifestBaseline'
import { getProxyConfig } from './util'
import { getBackendCatalog } from './adapter/coreRuntime'
import type { CoreBackendCatalog, CoreProxyConfig } from './adapter/coreRuntime'
import {
  getLocalInstalledBackendsInternal,
  BackendVersion,
  mapOldBackendToNew,
} from '../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/index'
import type { SettingUpdateResult } from '../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/types'

// Upstream provider points at the official ggml-org/llama.cpp release stream.
// Note: this is intentionally NOT janhq/llama.cpp (legacy fork mirror) and
// NOT AtomicBot-ai/atomic-llama-cpp-turboquant (our TurboQuant fork).
//
// Since ADR 2026-09-27 the backend *index* (what builds exist, which of them
// this machine can run, which one is recommended) is a question for
// atomic-chat-core: `loadCatalog` below asks `POST /backends/llamacpp-upstream/catalog`
// and everything in this extension reads from that one answer. The core owns
// the manifest transport (the atomic-chat-conf mirror, its fallbacks and its
// offline baseline), the hardware probe and the tier policy, so a decision is
// made once, from one set of facts, for the app and the CLI alike.
//
// The *archives* come from wherever the manifest's `download_base` points —
// normally our own signed mirror in atomic-chat-conf, whose Windows binaries
// are Authenticode-signed and whose macOS binaries carry a Developer ID
// signature. A tag we have not mirrored carries no `download_base` and falls
// back to the ggml-org CDN below, so a broken mirror degrades to the old
// behaviour instead of blocking engine updates.
const GGML_ORG_DOWNLOAD_BASE =
  'https://github.com/ggml-org/llama.cpp/releases/download'

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

// Tag of the bundled offline baseline. It is NOT a pin: a live manifest
// carrying a newer tag is followed as-is, which is what lets an upstream
// engine update reach users without an app release. Derived from the generated
// baseline so there is no second place to keep in step with the manifest.
export const BUNDLED_BASELINE_TAG = BUNDLED_MANIFEST_BASELINE.tag_name

/**
 * The last catalog the core answered with. Every reader in this session shares
 * it, so the core is asked once per launch unless a caller explicitly forces a
 * refresh (the "check for engine updates" button, a "Latest <variant>" pick).
 * A failed call leaves the previous answer in place.
 */
let _catalog: CoreBackendCatalog | null = null

/**
 * What builds exist for this provider on this machine, as the core sees it.
 *
 * `available` is the hardware-gated merge of the manifest and the disk that
 * `listSupportedBackends` used to compute here; `remote` is the manifest alone;
 * `recommended` / `recommended_installed` / `latest_by_type` / `static_variants`
 * are the picks `configureBackends` used to make itself. `force` bypasses both
 * this module's memo and the core's manifest cache, so a release published
 * while the app was open becomes visible.
 */
export async function loadCatalog(options?: {
  /** Ask the core to refetch the release stream too (a user-driven check). */
  force?: boolean
  /**
   * Ask the core again instead of answering from this module's memo, without forcing a refetch:
   * the core rescans the packs on disk (a backend installed from a file never passes through it),
   * while its own manifest cache still answers the remote half.
   */
  refresh?: boolean
  appVersion?: string | null
}): Promise<CoreBackendCatalog> {
  if (!options?.force && !options?.refresh && _catalog) return _catalog
  const catalog = await getBackendCatalog({
    force: options?.force ?? false,
    app_version: options?.appVersion ?? null,
    proxy: (getProxyConfig() as unknown as CoreProxyConfig | null) ?? null,
  })
  _catalog = catalog
  return catalog
}

/** The memoized catalog for readers that cannot await, or `null` before the first successful load. */
export function catalogSnapshot(): CoreBackendCatalog | null {
  return _catalog
}

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
 * Whitelist is deliberately narrow: `s390x`, `snapdragon-arm64`,
 * `rocm-7.2-x64` and `openvino-2026.0-x64` are dropped here. Adding
 * one is a one-line edit in this map + a feature detector in the Rust
 * `get_supported_features`. The arm64 CUDA 13 build carries its toolkit
 * minor, so it is matched by `LINUX_CUDA_BACKEND_RE` instead.
 */
const LINUX_UPSTREAM_ASSET_BY_BACKEND: Record<string, string> = {
  'linux-cpu-x64': 'ubuntu-x64',
  'linux-vulkan-x64': 'ubuntu-vulkan-x64',
  'linux-cpu-arm64': 'ubuntu-arm64',
  'linux-vulkan-arm64': 'ubuntu-vulkan-arm64',
}
const LINUX_CUDA_BACKEND_RE = /^linux-cuda-(13\.\d+)-arm64$/

/**
 * The manifest as the core resolved it for this platform and architecture, as
 * `version/backend` pairs. The core reads the atomic-chat-conf mirror (with its
 * own fallbacks and offline baseline), so the answer is never empty on a
 * platform the provider ships for; `force` re-reads the mirror.
 */
export async function fetchRemoteBackends(options?: {
  force?: boolean
  appVersion?: string | null
}): Promise<BackendVersion[]> {
  return (await loadCatalog(options)).remote
}

/**
 * Builds the download URL for a specific backend version on the ggml-org CDN.
 *
 * This is the un-mirrored fallback shape. The core resolves the real download
 * source (our signed mirror when the manifest lists the asset); this function
 * stays for callers that only need a URL.
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
  const linuxCuda = LINUX_CUDA_BACKEND_RE.exec(backend)
  const linuxInfix =
    LINUX_UPSTREAM_ASSET_BY_BACKEND[backend] ??
    (linuxCuda ? `ubuntu-cuda-${linuxCuda[1]}-arm64` : undefined)
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
  if (id.endsWith('cpu-x64') || id.endsWith('cpu-arm64')) return 'CPU'
  if (id.includes('opencl-adreno')) return 'OpenCL (Adreno)'
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

/// Unpacked size of the Windows HIP tree, measured from the archive's zip
/// central directory: 1072 MB on b10809 (ROCm 10.0), up from 936 MB on b10431
/// (ROCm 7.14). `ggml-hip.dll` alone is 896 MB because the whole HIP runtime is
/// linked into it, and ROCm 10 adds a 116 MB `amd_comgr.dll` beside it. By far
/// the largest backend in the product, and the reason a free-space precondition
/// exists at all. Re-measure on the next HIP major — the tree only grows.
const WIN_ROCM_UNPACKED_BYTES = 1080 * 1024 * 1024
/// Headroom over archive + unpacked so the check does not green-light an
/// install that lands the volume at zero free bytes.
const BACKEND_INSTALL_HEADROOM_BYTES = 200 * 1024 * 1024
/// Used when the manifest carries no size for the archive (an unmirrored tag).
/// Measured at 232.9 MB for `win-rocm-10.0-x64` in b10809.
const WIN_ROCM_ARCHIVE_BYTES_FALLBACK = 250 * 1024 * 1024

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
 * Matches a *minor-less* CUDA family id (e.g. `win-cuda-13-x64`,
 * `win-cuda-12-x64`, `win-cuda-13-arm64`, `linux-cuda-13-arm64`). These are
 * the family ids the Rust matrix (`determine_supported_backends`) and the TS
 * dropdown `staticVariants` emit — the concrete minor (`13.3`, `12.4`) is only
 * known once the ggml-org release stream is queried (ATO-105/ATO-174).
 */
const CUDA_FAMILY_RE = /^(win-cuda-(\d+)-(x64|arm64)|linux-cuda-(\d+)-(arm64))$/

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
 * `backend` is not a minor-less CUDA family id (concrete ids like
 * `win-cuda-13.3-x64` deliberately return `null` here — they need no
 * family resolution).
 */
export function cudaFamilyMajor(backend: string): string | null {
  const m = CUDA_FAMILY_RE.exec(backend.replace(/\uFEFF/g, '').trim())
  return m ? (m[2] ?? m[4]) : null
}

/**
 * Regex matching every concrete asset id of a version-less GPU family id, with
 * the version components captured so the newest can be picked. `null` when
 * `familyBackend` is not a family id.
 */
function gpuFamilyConcreteRe(familyBackend: string): RegExp | null {
  const id = familyBackend.replace(/\uFEFF/g, '').trim()
  if (id === WIN_ROCM_FAMILY_ID) return WIN_ROCM_CONCRETE_RE
  const m = CUDA_FAMILY_RE.exec(id)
  if (!m) return null
  return m[2]
    ? new RegExp(`^win-cuda-(${m[2]})\\.(\\d+)-${m[3]}$`)
    : new RegExp(`^linux-cuda-(${m[4]})\\.(\\d+)-${m[5]}$`)
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

/**
 * The builds this machine can run, as the core merged them: the manifest and the
 * installed packs, gated by the hardware tiers the core detected (Windows CUDA /
 * ROCm / Vulkan families, Linux Vulkan-or-CPU, the matching macOS arch). This
 * used to be assembled here from the plugin's feature flags; the core now
 * answers the same question for the app and the CLI from one probe.
 */
export async function listSupportedBackends(options?: {
  force?: boolean
  appVersion?: string | null
}): Promise<BackendVersion[]> {
  return (await loadCatalog(options)).available
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
      // `<backend>.incoming-<ts>` is atomic-chat-core staging an install it is running right now
      // (possibly for the CLI); it renames the folder into place when the archive is unpacked.
      if (backendType.includes('.incoming-')) continue
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

/**
 * What a `version_backend` setting change asks for, ported from the plugin's
 * `handle_setting_update` (`backend.rs`) so the Rust command can retire.
 *
 * The value is `version/backend` (a BOM left by PowerShell-generated files is
 * stripped first); the backend id is normalized through `mapOldBackendToNew`
 * so a legacy id persisted before the ggml-org switch still resolves, and the
 * preference is reported as updated when that normalized id differs from the
 * one stored (or nothing is stored). Rejects anything that is not exactly two
 * non-empty parts, as the Rust command did.
 */
export async function parseVersionBackendSetting(
  value: string,
  currentStoredBackend: string | undefined,
  mapBackend: (backend: string) => Promise<string> = mapOldBackendToNew
): Promise<SettingUpdateResult> {
  const cleanValue = value.replace(/\uFEFF/g, '')
  const parts = cleanValue.split('/')
  if (parts.length !== 2) {
    throw new Error(`Invalid backend format: ${cleanValue}`)
  }
  const version = parts[0].trim()
  const backend = parts[1].trim()
  if (!version || !backend) {
    throw new Error(`Invalid backend format: ${value}`)
  }

  const effectiveBackendType = (await mapBackend(backend)) || backend
  const backendTypeUpdated =
    currentStoredBackend === undefined ||
    currentStoredBackend !== effectiveBackendType

  return {
    backend_type_updated: backendTypeUpdated,
    effective_backend_type: effectiveBackendType,
    needs_backend_installation: true,
    version,
    backend,
  }
}
