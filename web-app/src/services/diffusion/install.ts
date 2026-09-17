/**
 * Installing the stable-diffusion.cpp prebuilt.
 *
 * The binary is never bundled in the installer; only the manifest snapshot is.
 * At first use this module resolves the pinned release from
 * `atomic-chat-conf/backends/sdcpp-manifest.json` (remote → cache → baseline),
 * picks the backend for this host, downloads the archive through the ordinary
 * download pipeline (proxy, sha256, size, download panel), unpacks it under
 * `<dataFolder>/diffusion/backends/<tag>/<backendId>/`, and hands the tree to
 * the plugin's `finalize_backend_install`, which sets the executable bits,
 * writes the ownership marker and probes `sd-cli --help`.
 *
 * An accelerator change installs the new tree first and removes the old one
 * only afterwards — and only when no session is running from it.
 */

import { invoke } from '@tauri-apps/api/core'
import { fetch as fetchTauri } from '@tauri-apps/plugin-http'
import { fs } from '@janhq/core'

import { getServiceHub } from '@/hooks/useServiceHub'
import {
  DIFFUSION_BACKENDS_DIR,
  DIFFUSION_DIR,
  getDiffusionPaths,
  joinDiffusionPath,
} from '@/lib/diffusion/config'
import { isArmArch } from '@/lib/hardware-tier'

import { BASELINE_SDCPP_MANIFEST } from '../sdcpp-manifest-baseline'
import {
  backendKindOf,
  companionFor,
  selectDiffusionBackend,
  type DiffusionBackendSelectionInput,
  type DiffusionHostArch,
  type DiffusionHostOs,
} from './backendMatrix'
import {
  cancelTransfer,
  downloadProxyConfig,
  emitTransferError,
  emitTransferProgress,
  emitTransferSuccess,
  sanitizeTaskId,
  transferFiles,
  type TransferItem,
} from './transfer'
import type {
  DiffusionBackendInstallRecord,
  NativeDiffusionErrorCode,
} from './types'

// --- manifest ---------------------------------------------------------------

export type SdcppAsset = {
  /** Stable backend id the client selects on — the only field it matches against. */
  backend: string
  name: string
  sha256?: string
  size?: number
  /** The Windows CUDA runtime archive, unpacked beside the CUDA backend. */
  companion?: boolean
}

export type SdcppManifest = {
  updated_at?: string
  upstream_repo?: string
  /** leejet tag, e.g. `master-849-d04e895`; `-a<sha>` marks an Atomic-built variant. */
  tag_name: string
  /** Set once the mirror has re-signed and re-hosted the archives. */
  download_base?: string
  assets: SdcppAsset[]
}

export type SdcppManifestSource = 'remote' | 'cache' | 'baseline'

export type SdcppManifestResult = {
  manifest: SdcppManifest
  source: SdcppManifestSource
  fetchedAt: number | null
  error?: string
}

export const DEFAULT_SDCPP_MANIFEST_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/sdcpp-manifest.json'

export const SDCPP_MANIFEST_URL: string =
  (import.meta.env.VITE_SDCPP_MANIFEST_URL as string | undefined) ??
  DEFAULT_SDCPP_MANIFEST_URL

export const DEFAULT_UPSTREAM_REPO = 'leejet/stable-diffusion.cpp'

export const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_KEY = 'atomic_sdcpp_manifest_cache_v1'
const CACHE_TS_KEY = 'atomic_sdcpp_manifest_cache_ts_v1'
const FETCH_TIMEOUT_MS = 5000

const TAG_RE = /^[A-Za-z0-9._-]+$/
const BACKEND_ID_RE = /^[a-z0-9.-]+$/
const ASSET_NAME_RE = /^[A-Za-z0-9._-]+\.(zip|tar\.gz)$/
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA256_RE = /^[0-9a-f]{64}$/
/** The Atomic-built variant suffix; stripped when falling back to the upstream CDN. */
const ATOMIC_TAG_SUFFIX_RE = /-a[0-9a-f]{7}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sanitizeAsset = (raw: unknown): SdcppAsset | null => {
  if (!isRecord(raw)) return null
  if (typeof raw.backend !== 'string' || !BACKEND_ID_RE.test(raw.backend))
    return null
  if (typeof raw.name !== 'string' || !ASSET_NAME_RE.test(raw.name)) return null
  const sha256 =
    typeof raw.sha256 === 'string' && SHA256_RE.test(raw.sha256)
      ? raw.sha256
      : undefined
  const size =
    typeof raw.size === 'number' && Number.isInteger(raw.size) && raw.size > 0
      ? raw.size
      : undefined
  return {
    backend: raw.backend,
    name: raw.name,
    ...(sha256 ? { sha256 } : {}),
    ...(size ? { size } : {}),
    ...(raw.companion === true ? { companion: true } : {}),
  }
}

/** Parse an untrusted payload into a manifest, or throw. Unknown keys are dropped. */
export const parseSdcppManifest = (data: unknown): SdcppManifest => {
  if (!isRecord(data)) throw new Error('sd.cpp manifest payload is not an object')
  if (typeof data.tag_name !== 'string' || !TAG_RE.test(data.tag_name)) {
    throw new Error('sd.cpp manifest has no usable tag_name')
  }
  if (!Array.isArray(data.assets)) throw new Error('sd.cpp manifest has no assets')
  const assets: SdcppAsset[] = []
  const seen = new Set<string>()
  for (const raw of data.assets) {
    const asset = sanitizeAsset(raw)
    if (!asset || seen.has(asset.backend)) continue
    seen.add(asset.backend)
    assets.push(asset)
  }
  if (assets.length === 0) throw new Error('sd.cpp manifest lists no usable asset')
  const upstreamRepo =
    typeof data.upstream_repo === 'string' && REPO_RE.test(data.upstream_repo)
      ? data.upstream_repo
      : undefined
  const downloadBase =
    typeof data.download_base === 'string' &&
    /^https:\/\/[^\s]+$/.test(data.download_base)
      ? data.download_base.replace(/\/+$/, '')
      : undefined
  return {
    ...(typeof data.updated_at === 'string' ? { updated_at: data.updated_at } : {}),
    ...(upstreamRepo ? { upstream_repo: upstreamRepo } : {}),
    tag_name: data.tag_name,
    ...(downloadBase ? { download_base: downloadBase } : {}),
    assets,
  }
}

const safeLocalStorage = (): Storage | null => {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    return null
  }
}

export type CachedSdcppManifest = { manifest: SdcppManifest; fetchedAt: number }

export const getCachedSdcppManifest = (): CachedSdcppManifest | null => {
  const ls = safeLocalStorage()
  if (!ls) return null
  try {
    const raw = ls.getItem(CACHE_KEY)
    const tsRaw = ls.getItem(CACHE_TS_KEY)
    if (!raw || !tsRaw) return null
    const fetchedAt = Number(tsRaw)
    if (!Number.isFinite(fetchedAt)) return null
    return { manifest: parseSdcppManifest(JSON.parse(raw)), fetchedAt }
  } catch {
    return null
  }
}

export const clearSdcppManifestCache = (): void => {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.removeItem(CACHE_KEY)
    ls.removeItem(CACHE_TS_KEY)
  } catch (error) {
    console.warn('[diffusion-install] Failed to clear manifest cache:', error)
  }
}

const writeCache = (manifest: SdcppManifest, fetchedAt: number): void => {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.setItem(CACHE_KEY, JSON.stringify(manifest))
    ls.setItem(CACHE_TS_KEY, String(fetchedAt))
  } catch (error) {
    console.warn('[diffusion-install] Failed to write manifest cache:', error)
  }
}

const isTauriRuntime = (): boolean => {
  try {
    return typeof IS_TAURI !== 'undefined' && Boolean(IS_TAURI)
  } catch {
    return false
  }
}

const fetchOnce = async (
  fetcher: typeof fetch,
  url: string,
  signal?: AbortSignal
): Promise<unknown> => {
  const response = await fetcher(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!response.ok) {
    throw new Error(
      `sd.cpp manifest fetch failed: ${response.status} ${response.statusText}`
    )
  }
  return (await response.json()) as unknown
}

const fetchManifest = async (
  url: string,
  signal?: AbortSignal
): Promise<SdcppManifest> => {
  let data: unknown
  try {
    data = await fetchOnce(fetch, url, signal)
  } catch (primaryError) {
    if (!isTauriRuntime()) throw primaryError
    data = await fetchOnce(fetchTauri as typeof fetch, url, signal)
  }
  return parseSdcppManifest(data)
}

const withHardTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`sd.cpp manifest fetch timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })

export type SdcppManifestFetchOptions = {
  force?: boolean
  url?: string
  timeoutMs?: number
}

export const getBaselineSdcppManifest = (): SdcppManifest =>
  parseSdcppManifest(BASELINE_SDCPP_MANIFEST)

/** Remote → cache → baseline; never throws. */
export const resolveSdcppManifest = async (
  options: SdcppManifestFetchOptions = {}
): Promise<SdcppManifestResult> => {
  const {
    force = false,
    url = SDCPP_MANIFEST_URL,
    timeoutMs = FETCH_TIMEOUT_MS,
  } = options
  const cached = getCachedSdcppManifest()
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { manifest: cached.manifest, source: 'cache', fetchedAt: cached.fetchedAt }
  }
  const controller = new AbortController()
  const fetchUrl = force
    ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
    : url
  try {
    const manifest = await withHardTimeout(
      fetchManifest(fetchUrl, controller.signal),
      timeoutMs
    )
    const fetchedAt = Date.now()
    writeCache(manifest, fetchedAt)
    return { manifest, source: 'remote', fetchedAt }
  } catch (error) {
    try {
      controller.abort()
    } catch {
      // ignore
    }
    const message =
      error instanceof Error ? error.message : 'Unknown sd.cpp manifest error'
    console.warn('[diffusion-install] Falling back:', message)
    if (cached) {
      return {
        manifest: cached.manifest,
        source: 'cache',
        fetchedAt: cached.fetchedAt,
        error: message,
      }
    }
    return {
      manifest: getBaselineSdcppManifest(),
      source: 'baseline',
      fetchedAt: null,
      error: message,
    }
  }
}

// --- pure helpers -----------------------------------------------------------

/** `master-849-d04e895-a1b2c3d4` → `master-849-d04e895`; upstream tags pass through. */
export function stripAtomicTagSuffix(tag: string): string {
  return tag.replace(ATOMIC_TAG_SUFFIX_RE, '')
}

/**
 * Where to fetch an asset from. The signed mirror when the manifest names
 * one; otherwise the upstream GitHub release, whose tag never carries the
 * Atomic variant suffix.
 */
export function assetUrl(manifest: SdcppManifest, asset: SdcppAsset): string {
  if (manifest.download_base) {
    return `${manifest.download_base}/${manifest.tag_name}/${asset.name}`
  }
  const repo = manifest.upstream_repo ?? DEFAULT_UPSTREAM_REPO
  return `https://github.com/${repo}/releases/download/${stripAtomicTagSuffix(
    manifest.tag_name
  )}/${asset.name}`
}

/** `<dataFolder>/diffusion/backends/<tag>/<backendId>` */
export function backendInstallDir(
  dataFolder: string,
  tag: string,
  backendId: string
): string {
  return joinDiffusionPath(
    dataFolder,
    DIFFUSION_DIR,
    DIFFUSION_BACKENDS_DIR,
    tag,
    backendId
  )
}

/** Download-panel row id; must satisfy Tauri's event-name alphabet. */
export function diffusionBackendTaskId(tag: string, backendId: string): string {
  return `diffusion-backend-${sanitizeTaskId(tag)}-${sanitizeTaskId(backendId)}`
}

export class DiffusionInstallError extends Error {
  code: NativeDiffusionErrorCode
  details?: string

  constructor(code: NativeDiffusionErrorCode, message: string, details?: string) {
    super(message)
    this.name = 'DiffusionInstallError'
    this.code = code
    this.details = details
  }
}

/** The plugin rejects with a serialised `DiffusionError`; read its code if present. */
export function errorCodeOf(error: unknown): NativeDiffusionErrorCode | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' ? (code as NativeDiffusionErrorCode) : undefined
}

// --- host -------------------------------------------------------------------

export type DiffusionHost = Omit<DiffusionBackendSelectionInput, 'available'>

const hostOs = (osType: string | undefined): DiffusionHostOs => {
  if (osType === 'macos' || osType === 'windows' || osType === 'linux') return osType
  if (typeof IS_MACOS !== 'undefined' && IS_MACOS) return 'macos'
  if (typeof IS_WINDOWS !== 'undefined' && IS_WINDOWS) return 'windows'
  return 'linux'
}

const hostArch = (arch: string | undefined): DiffusionHostArch =>
  isArmArch(arch) ? 'arm64' : 'x64'

/**
 * What the backend matrix needs to know about this machine. The feature
 * probe is the llama.cpp upstream plugin's — same driver checks, same
 * generated AMD table — so the two providers agree on what the host can run.
 */
export async function describeDiffusionHost(): Promise<DiffusionHost> {
  const hub = getServiceHub()
  const hardware = await hub.hardware().getHardwareInfo()
  const os = hostOs(hardware?.os_type)
  const arch = hostArch(hardware?.cpu?.arch)
  const gpus = (hardware?.gpus ?? []).map((gpu) => ({
    vendor: gpu.vendor,
    totalMemoryMib: gpu.total_memory,
  }))
  let features: DiffusionHost['features'] = {}
  if (os !== 'macos') {
    try {
      const probed = await invoke<Record<string, unknown>>(
        'plugin:llamacpp-upstream|get_supported_features',
        {
          osType: os,
          cpuExtensions: hardware?.cpu?.extensions ?? [],
          gpus: hardware?.gpus ?? [],
        }
      )
      features = {
        cuda12: probed?.cuda12 === true,
        cuda13: probed?.cuda13 === true,
        vulkan: probed?.vulkan === true,
        rocm: probed?.rocm === true,
      }
    } catch (error) {
      console.warn(
        '[diffusion-install] get_supported_features failed; assuming CPU only:',
        error
      )
    }
  }
  return { os, arch, features, gpus }
}

/** The backend this host would install from `manifest`, or null when none applies. */
export function selectBackendForHost(
  host: DiffusionHost,
  manifest: SdcppManifest
): string | null {
  return selectDiffusionBackend({
    ...host,
    available: manifest.assets.filter((a) => !a.companion).map((a) => a.backend),
  })
}

/** Why no backend applies, in words the settings card can show. */
function unsupportedReason(host: DiffusionHost): string {
  if (host.os === 'macos') {
    return 'Image generation needs an Apple Silicon Mac; Intel Macs are not supported.'
  }
  if (host.arch !== 'x64') {
    return `No stable-diffusion.cpp build is published for ${host.arch} ${host.os}.`
  }
  return 'The release manifest lists no build for this computer.'
}

/**
 * The backend this host installs, resolved end to end (hardware probe,
 * live manifest). `reason` is set only when `backendId` is null.
 */
export async function selectDiffusionBackendForHost(): Promise<{
  backendId: string | null
  reason?: string
}> {
  const [{ manifest }, host] = await Promise.all([
    resolveSdcppManifest(),
    describeDiffusionHost(),
  ])
  const backendId = selectBackendForHost(host, manifest)
  return backendId ? { backendId } : { backendId: null, reason: unsupportedReason(host) }
}

// --- install ----------------------------------------------------------------

/** Archive plus its unpacked tree, generously: the CUDA build unpacks to ~3×. */
const DISK_SPACE_FACTOR = 3

async function ensureDiskSpace(
  probePath: string,
  archiveBytes: number
): Promise<void> {
  if (archiveBytes <= 0) return
  const required = archiveBytes * DISK_SPACE_FACTOR
  let free: number
  try {
    free = await invoke<number>('plugin:llamacpp-upstream|available_disk_space', {
      path: probePath,
    })
  } catch (error) {
    console.warn(
      '[diffusion-install] could not measure free disk space, continuing:',
      error
    )
    return
  }
  if (free >= required) return
  const toGiB = (bytes: number) => (bytes / 1024 ** 3).toFixed(1)
  throw new DiffusionInstallError(
    'DISK_FULL',
    `Not enough free disk space to install the image engine: ${toGiB(required)} GB needed, ${toGiB(free)} GB free.`
  )
}

const exists = async (path: string): Promise<boolean> => {
  try {
    return Boolean(await fs.existsSync(path))
  } catch {
    return false
  }
}

/** The CUDA runtime DLL the companion archive provides. */
const CUDART_MARKER = 'cudart64_12.dll'

async function retireOtherBackends(
  installed: DiffusionBackendInstallRecord[],
  keep: DiffusionBackendInstallRecord
): Promise<void> {
  const diffusion = getServiceHub().diffusion()
  for (const record of installed) {
    if (record.dir === keep.dir) continue
    try {
      await diffusion.removeBackend(record.dir)
      console.info(`[diffusion-install] removed ${record.tag}/${record.backendId}`)
    } catch (error) {
      if (errorCodeOf(error) === 'BACKEND_IN_USE') {
        console.info(
          `[diffusion-install] keeping ${record.tag}/${record.backendId}: a session still runs from it`
        )
      } else {
        console.warn(
          `[diffusion-install] could not remove ${record.tag}/${record.backendId}:`,
          error
        )
      }
    }
  }
}

export type EnsureDiffusionBackendOptions = {
  onProgress?: (progress: { transferred: number; total: number }) => void
  /** Reinstall even when the selected backend is already on disk. */
  force?: boolean
}

/**
 * Make sure the right sd.cpp build for this host is installed, downloading
 * it when it is not. Resolves to the install record either way.
 */
export async function ensureDiffusionBackend(
  options: EnsureDiffusionBackendOptions = {}
): Promise<DiffusionBackendInstallRecord> {
  const hub = getServiceHub()
  const diffusion = hub.diffusion()
  const { manifest } = await resolveSdcppManifest()
  const host = await describeDiffusionHost()
  const backendId = selectBackendForHost(host, manifest)
  if (!backendId) {
    throw new DiffusionInstallError(
      'UNSUPPORTED_BACKEND',
      'No stable-diffusion.cpp build is published for this computer.'
    )
  }
  const asset = manifest.assets.find((a) => a.backend === backendId)
  if (!asset) {
    throw new DiffusionInstallError(
      'ENGINE_INSTALL_FAILED',
      `The manifest lists no archive for ${backendId}.`
    )
  }

  const tag = manifest.tag_name
  const installed = await diffusion.listInstalledBackends()
  const current = installed.find(
    (record) => record.tag === tag && record.backendId === backendId
  )
  if (current && !options.force) return current

  const { dataFolder, backendsRoot } = await getDiffusionPaths()
  const dir = backendInstallDir(dataFolder, tag, backendId)
  const stagingDir = joinDiffusionPath(backendsRoot, 'tmp')

  const archives: SdcppAsset[] = [asset]
  const companionId = companionFor(backendId)
  const companion = companionId
    ? manifest.assets.find((a) => a.backend === companionId)
    : undefined
  if (companion && !(await exists(joinDiffusionPath(dir, CUDART_MARKER)))) {
    archives.push(companion)
  }

  const totalBytes = archives.reduce((sum, a) => sum + (a.size ?? 0), 0)
  await ensureDiskSpace(dataFolder, totalBytes)

  const taskId = diffusionBackendTaskId(tag, backendId)
  const proxy = downloadProxyConfig()
  const items: TransferItem[] = archives.map((archive) => ({
    url: assetUrl(manifest, archive),
    save_path: joinDiffusionPath(stagingDir, archive.name),
    ...(proxy ? { proxy } : {}),
    ...(archive.sha256 ? { sha256: archive.sha256 } : {}),
    ...(archive.size ? { size: archive.size } : {}),
    model_id: taskId,
  }))

  try {
    if (!(await exists(stagingDir))) await fs.mkdir(stagingDir)
    emitTransferProgress(taskId, 'Backend', 0, totalBytes)
    await transferFiles(items, taskId, {
      onProgress: (transferred, total) => {
        options.onProgress?.({ transferred, total })
        emitTransferProgress(taskId, 'Backend', transferred, total)
      },
    })
    for (const item of items) {
      await invoke('decompress', { path: item.save_path, outputDir: dir })
    }
    const record = await diffusion.finalizeBackendInstall({
      dir,
      tag,
      backendId,
      backend: backendKindOf(backendId),
      engine: 'sd-cpp',
      ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
    })
    emitTransferSuccess(taskId, 'Backend', totalBytes)
    await retireOtherBackends(installed, record)
    for (const item of items) {
      try {
        await fs.rm(item.save_path)
      } catch {
        // A leftover archive costs disk, not correctness.
      }
    }
    return record
  } catch (error) {
    emitTransferError(taskId, 'Backend', error)
    throw error
  }
}

/** Stop an in-flight engine download; the panel's cancel button lands here. */
export async function cancelDiffusionBackendInstall(
  tag: string,
  backendId: string
): Promise<void> {
  await cancelTransfer(diffusionBackendTaskId(tag, backendId))
}
