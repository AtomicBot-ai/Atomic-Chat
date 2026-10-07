/**
 * Getting a model into the shared store of the managed engines (spec `tensorrt-llm-models`,
 * `tensorrt-llm-desktop` "Выбор и скачивание модели", `managed-model-store`): the app downloads, an
 * engine decides whether a checkpoint can run. A model is downloaded once, for every managed engine.
 *
 * 1. Read the repository at a revision from Hugging Face — pinned to its commit, so every file is
 *    read and downloaded from the same tree: `config.json`, `hf_quant_config.json` when the
 *    repository has one, every file with its size and LFS sha256, and the tensor names in the
 *    headers of its weight files (a range request each; no weights are downloaded). A refusal means
 *    the model is gated and its terms were not accepted: the person is sent to the model page.
 * 2. Ask the engine the download is for (`POST /models/<engine>/check`, no network on the core's
 *    side). Incompatible means nothing is downloaded, and the reason — with numbers, and the other
 *    cards it would fit on — goes back to the person.
 * 3. Ask the core where the store is and how much room there is (`GET /managed-models/location`,
 *    change `add-vllm-runtime`): `<data>/managed-models` on Linux, a folder in Atomic Chat's WSL
 *    distribution (`\\wsl.localhost\…`) on Windows. Without room for what is still to download,
 *    nothing is downloaded.
 * 4. Download every file into `<root>/<repository>/`, verified by size and LFS sha256, resuming
 *    partial files and skipping files already complete.
 * 5. Write `model.yml` last: a folder without one is a download in progress, not a model. It names
 *    nothing engine-dependent: each engine names the quantization format from the files itself.
 * 6. Report it as the download panel's row under one id (`managedDownloadId`, change
 *    `add-tensorrt-llm-model-hub`, design D6) — progress, then its end: done, stopped by a cancel
 *    (partial files stay, Download again resumes them), or the reason it failed. The end also
 *    closes the "Validating Model" toast the downloader opened under the same id.
 */

import { invoke } from '@tauri-apps/api/core'
import { DownloadEvent, events, fs } from '@janhq/core'

import type {
  CheckpointFile,
  DescriptorSummary,
  ModelCompatibility,
} from '@/services/managed-environment/types'
import { isDownloadCancellationError } from '@/lib/downloadCancellation'
import { ExtensionManager } from '@/lib/extension'
import { managedDownloadId } from '@/lib/managed-engine/download-id'
import {
  isTransferValidationError,
  transferFiles,
  type TransferItem,
  type TransferOptions,
} from '@/services/diffusion/transfer'

export { managedDownloadId }

const HF = 'https://huggingface.co'

/** Hugging Face refused access: the model is gated and its terms are not accepted with this token. */
export class GatedModelError extends Error {
  constructor(
    readonly repository: string,
    readonly url = `${HF}/${repository}`
  ) {
    super(`Access to ${repository} was refused.`)
    this.name = 'GatedModelError'
  }
}

/** The core's `check` said no; nothing was downloaded. */
export class IncompatibleModelError extends Error {
  constructor(readonly compatibility: ModelCompatibility) {
    super(compatibility.verdict.ok ? 'compatible' : compatibility.verdict.error.message)
    this.name = 'IncompatibleModelError'
  }

  get code(): string {
    return this.compatibility.verdict.ok ? '' : this.compatibility.verdict.error.code
  }

  /** Other cards on this machine the model would fit on, for "try the other card". */
  get fitsOtherGpus(): string[] {
    return this.compatibility.fits_other_gpus
  }
}

/** The core has less room for the model than is still to download; nothing was downloaded. */
export class InsufficientModelSpaceError extends Error {
  constructor(
    readonly root: string,
    readonly neededBytes: number,
    readonly freeBytes: number
  ) {
    super(`Not enough free space for the model in ${root}.`)
    this.name = 'InsufficientModelSpaceError'
  }
}

/**
 * `GET /managed-models/location`: the one root every managed engine's models are downloaded into,
 * as this machine opens it, and the free space for new models there (on Windows the smaller of the
 * guest's and the volume's that holds the distribution); `free_bytes` is null when the core could
 * not measure it.
 */
export interface ManagedModelLocation {
  root: string
  free_bytes: number | null
}

export interface HfRevision {
  repository: string
  /** The commit the requested revision resolved to. */
  revision: string
  config_json: unknown
  hf_quant_config_json: unknown | null
  files: CheckpointFile[]
  /**
   * The tensor names in the weight files' safetensors headers, numeric path segments folded to `*`;
   * absent when any header could not be read — the core then skips the checks that need them.
   */
  weight_names?: string[]
}

interface HfSibling {
  rfilename: string
  size?: number
  lfs?: { sha256?: string; size?: number }
}

function headers(token: string | undefined): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function hfJson(
  url: string,
  repository: string,
  token: string | undefined,
  fetchImpl: typeof fetch
): Promise<unknown> {
  const response = await fetchImpl(url, { headers: headers(token) })
  if (response.status === 401 || response.status === 403) throw new GatedModelError(repository)
  if (!response.ok) {
    throw new Error(`Hugging Face answered ${response.status} for ${url}`)
  }
  return response.json()
}

/** `model.safetensors` or a standard shard (`model-00001-of-00003.safetensors`), at the repository root. */
const MODEL_SHARD = /^model(-\d+-of-\d+)?\.safetensors$/i

/**
 * The files whose headers name the checkpoint's tensors: the standard shards when there are any,
 * otherwise every root-level `.safetensors` — the core's own weight-file rule (`compatibility.ts`).
 */
function weightSafetensors(files: readonly CheckpointFile[]): CheckpointFile[] {
  const root = files.filter((file) => !file.path.includes('/') && file.path.toLowerCase().endsWith('.safetensors'))
  const shards = root.filter((file) => MODEL_SHARD.test(file.path))
  return shards.length > 0 ? shards : root
}

/** Most headers fit in the first request, so a shard costs one round trip, not two. */
const HEADER_PROBE_BYTES = 256 * 1024
/** Beyond this, not a header the app reads (real ones are kilobytes to a few megabytes). */
const MAX_HEADER_BYTES = 100 * 1024 * 1024
/** Header requests in flight at once: a 47-shard checkpoint reads in a few rounds, not 47. */
const HEADER_CONCURRENCY = 8

/**
 * `bytes=from-to` of one file, or null when Hugging Face did not answer with that range (`206`):
 * a server that ignores `Range` would otherwise start sending gigabytes of weights.
 */
async function rangeBytes(
  url: string,
  from: number,
  to: number,
  token: string | undefined,
  fetchImpl: typeof fetch
): Promise<Uint8Array | null> {
  const response = await fetchImpl(url, { headers: { ...headers(token), Range: `bytes=${from}-${to}` } })
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  return new Uint8Array(await response.arrayBuffer())
}

/** The tensor names in one `.safetensors` file's header (8-byte little-endian length, then JSON). */
async function headerTensorNames(
  url: string,
  token: string | undefined,
  fetchImpl: typeof fetch
): Promise<string[] | null> {
  const first = await rangeBytes(url, 0, HEADER_PROBE_BYTES - 1, token, fetchImpl)
  if (first === null || first.length < 8) return null
  const length = Number(new DataView(first.buffer, first.byteOffset, 8).getBigUint64(0, true))
  if (length <= 0 || length > MAX_HEADER_BYTES) return null
  const header =
    first.length >= 8 + length
      ? first.subarray(8, 8 + length)
      : await rangeBytes(url, 8, 8 + length - 1, token, fetchImpl)
  if (header === null || header.length !== length) return null
  const parsed: unknown = JSON.parse(new TextDecoder().decode(header))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return Object.keys(parsed).filter((key) => key !== '__metadata__')
}

/** `model.layers.12.mlp.experts.7.w1` → `model.layers.*.mlp.experts.*.w1`: a 90k-name MoE index folds to hundreds. */
export function foldTensorName(name: string): string {
  return name.replace(/(?<=^|\.)\d+(?=\.|$)/g, '*')
}

/**
 * Every weight file's tensor names, folded and de-duplicated; undefined when there is no weight
 * file or any header cannot be read — never an error: the names only sharpen the core's check.
 */
export async function readWeightNames(
  files: readonly CheckpointFile[],
  resolve: (path: string) => string,
  token: string | undefined,
  fetchImpl: typeof fetch
): Promise<string[] | undefined> {
  const weights = weightSafetensors(files)
  if (weights.length === 0) return undefined
  const names = new Set<string>()
  try {
    for (let start = 0; start < weights.length; start += HEADER_CONCURRENCY) {
      const batch = weights.slice(start, start + HEADER_CONCURRENCY)
      const results = await Promise.all(batch.map((file) => headerTensorNames(resolve(file.path), token, fetchImpl)))
      for (const own of results) {
        if (own === null) return undefined
        for (const name of own) names.add(foldTensorName(name))
      }
    }
  } catch {
    return undefined
  }
  return [...names].sort()
}

/** The body of `POST /models/<engine>/check` for a revision read by `fetchHfRevision`. */
export function checkRequestFor(meta: HfRevision, gpuId?: string): CheckRequest {
  return {
    repository: meta.repository,
    revision: meta.revision,
    config_json: meta.config_json,
    hf_quant_config_json: meta.hf_quant_config_json,
    files: meta.files,
    ...(gpuId ? { gpu_id: gpuId } : {}),
    ...(meta.weight_names ? { weight_names: meta.weight_names } : {}),
  }
}

/** Normalises what a person pastes: a repo id or its huggingface.co URL. */
export function normalizeRepository(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\/(www\.)?huggingface\.co\//, '')
    .replace(/^huggingface\.co\//, '')
    .replace(/\/+$/, '')
}

export async function fetchHfRevision(
  repository: string,
  revision: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<HfRevision> {
  const listing = (await hfJson(
    `${HF}/api/models/${repository}/revision/${encodeURIComponent(revision ?? 'main')}?blobs=true&files_metadata=true`,
    repository,
    token,
    fetchImpl
  )) as { sha?: string; siblings?: HfSibling[] }
  if (!listing.sha) throw new Error(`Hugging Face did not name the commit of ${repository}`)
  const files: CheckpointFile[] = (listing.siblings ?? []).map((sibling) => ({
    path: sibling.rfilename,
    size: sibling.lfs?.size ?? sibling.size ?? 0,
    sha256: sibling.lfs?.sha256 ?? null,
  }))
  const resolve = (path: string) => `${HF}/${repository}/resolve/${listing.sha}/${path}`
  const has = (path: string) => files.some((file) => file.path === path)
  const weightNames = await readWeightNames(files, resolve, token, fetchImpl)
  return {
    repository,
    revision: listing.sha,
    config_json: await hfJson(resolve('config.json'), repository, token, fetchImpl),
    hf_quant_config_json: has('hf_quant_config.json')
      ? await hfJson(resolve('hf_quant_config.json'), repository, token, fetchImpl)
      : null,
    files,
    ...(weightNames ? { weight_names: weightNames } : {}),
  }
}

/** The body of a managed engine's `check`. */
export interface CheckRequest {
  repository: string
  revision: string
  config_json: unknown
  hf_quant_config_json: unknown | null
  files: CheckpointFile[]
  gpu_id?: string
  /** Needs a core that knows the field (it refuses fields it does not know with `INVALID_ARGUMENT`). */
  weight_names?: string[]
}

export interface InstallDeps {
  fetch: typeof fetch
  /** The verdict of the engine `engineId` on the checkpoint. */
  check: (engineId: string, request: CheckRequest) => Promise<ModelCompatibility>
  /** Where the core keeps the store, and the room there. */
  location: () => Promise<ManagedModelLocation>
  /** Size of a file (an absolute path), or null when it is not there. */
  existingSize: (savePath: string) => Promise<number | null>
  /** Whether a download of this file was started and left a partial (`<file>.tmp`) behind. */
  hasPartial: (savePath: string) => Promise<boolean>
  transfer: (items: TransferItem[], taskId: string, options: TransferOptions) => Promise<void>
  writeYaml: (savePath: string, data: unknown) => Promise<void>
  /** The app's download events (`events.emit`), which the download toasts follow. */
  emit: (event: string, payload: unknown) => void
}

export interface InstallRequest {
  /**
   * The engine whose verdict lets the download start: one that accepts the model (spec
   * `vllm-desktop`, "Карточка модели показывает вердикт каждого managed-движка"). The model itself
   * lands in the shared store, for every managed engine.
   */
  engineId: string
  repository: string
  revision?: string
  token?: string
  gpuId?: string
  onProgress?: (transferred: number, total: number) => void
}

/**
 * `relative` (a repository, a file path in it: `/`-separated) under `root`, spelled with the root's
 * own separator — a Windows UNC root gets backslashes throughout.
 */
export function underRoot(root: string, ...relative: string[]): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const tail = relative.join('/').split('/').filter(Boolean).join(separator)
  return `${root.replace(/[\\/]+$/, '')}${separator}${tail}`
}

/** Checks, downloads and records one model; rejects before any download when it cannot run here. */
export async function installManagedModel(
  request: InstallRequest,
  deps: InstallDeps = defaultInstallDeps()
): Promise<{ modelId: string; compatibility: ModelCompatibility }> {
  const repository = normalizeRepository(request.repository)
  const meta = await fetchHfRevision(repository, request.revision, request.token, deps.fetch)
  const compatibility = await deps.check(request.engineId, checkRequestFor(meta, request.gpuId))
  if (!compatibility.verdict.ok) throw new IncompatibleModelError(compatibility)

  // Only for a model that can run here; before Atomic Chat's distribution exists on Windows the
  // core refuses (`MANAGED_ADAPTER_UNAVAILABLE`) and nothing is downloaded.
  const { root, free_bytes: freeBytes } = await deps.location()
  const downloadId = managedDownloadId(repository)
  const pending: TransferItem[] = []
  for (const file of meta.files) {
    const savePath = underRoot(root, repository, file.path)
    // Complete files are not fetched again; a partial one is resumed by the downloader.
    if ((await deps.existingSize(savePath)) === file.size) continue
    pending.push({
      url: `${HF}/${repository}/resolve/${meta.revision}/${file.path}`,
      save_path: savePath,
      size: file.size,
      model_id: downloadId,
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
    })
  }
  const downloaded = pending.reduce((total, item) => total + (item.size ?? 0), 0)
  // The core's number, not the data folder's volume: on Windows the models live in the guest. A
  // resumed download needs only what its partials lack, which only the downloader can count
  // (`.parts` maps): it checks the same number then, so the app leaves that case to it.
  const resuming = (await Promise.all(pending.map((item) => deps.hasPartial(item.save_path)))).some(Boolean)
  if (freeBytes !== null && !resuming && freeBytes < downloaded) {
    throw new InsufficientModelSpaceError(root, downloaded, freeBytes)
  }
  try {
    if (pending.length > 0) {
      await deps.transfer(pending, downloadId, {
        resume: true,
        ...(request.token ? { hfToken: request.token } : {}),
        onProgress: (transferred, total) => {
          // The downloader's status-only events (`{ stage }`, while it retries) carry no bytes;
          // as progress they would rewind the panel's bar (#290).
          if (typeof transferred !== 'number' || typeof total !== 'number') return
          deps.emit(DownloadEvent.onFileDownloadUpdate, {
            modelId: downloadId,
            percent: total > 0 ? transferred / total : 0,
            size: { transferred, total },
            downloadType: 'Model',
          })
          request.onProgress?.(transferred, total)
        },
      })
    }

    // Last: this file is what turns the folder into a model for the core and the extensions. No
    // quantization: that is each engine's own reading of the files (spec `managed-model-store`).
    await deps.writeYaml(underRoot(root, repository, 'model.yml'), {
      repository,
      revision: meta.revision,
      architectures: compatibility.architectures,
      files: meta.files,
    })
  } catch (error) {
    if (pending.length > 0) emitDownloadEnded(deps, downloadId, error)
    throw error
  }
  // The Rust downloader opened a "Validating Model" toast for `downloadId` (each item's
  // `model_id`) once the files arrived, and only a terminal download event closes it (F-10); the
  // same event ends the panel's row. Sent only after a download: with every file already on disk
  // nothing was fetched or checked.
  if (pending.length > 0) {
    deps.emit(DownloadEvent.onFileDownloadSuccess, {
      modelId: downloadId,
      downloadType: 'Model',
      size: { transferred: downloaded, total: downloaded },
    })
  }
  return { modelId: repository, compatibility }
}

/**
 * End the download's row and toasts as a chat-model download ends them: a cancel as stopped (the
 * panel then offers nothing to report, and the partials stay for Download again), a file that
 * failed its size or sha256 check (the downloader has already removed it) as a validation failure,
 * anything else as a download error.
 */
function emitDownloadEnded(deps: InstallDeps, downloadId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  if (isDownloadCancellationError(error)) {
    deps.emit(DownloadEvent.onFileDownloadStopped, { modelId: downloadId, downloadType: 'Model' })
  } else if (isTransferValidationError(error)) {
    deps.emit(DownloadEvent.onModelValidationFailed, {
      modelId: downloadId,
      downloadType: 'Model',
      error: message,
      reason: 'validation_failed',
    })
  } else {
    deps.emit(DownloadEvent.onFileDownloadError, {
      modelId: downloadId,
      downloadType: 'Model',
      error: message,
    })
  }
}

function coreCall<T>(method: 'GET' | 'POST', path: string, body: unknown = null): Promise<T> {
  return invoke<T>('atomic_core_call', { method, path, body })
}

/**
 * `POST /models/<engine>/check`: the engine's verdict on a checkpoint, by that engine's descriptor.
 * The core judges memory with its own copy of the engine's settings, which the extension otherwise
 * hands over only when a model loads; it is handed over first, so a verdict follows the settings the
 * person just changed. An engine whose extension is not loaded is asked all the same.
 */
export async function checkManagedModel(engineId: string, request: CheckRequest): Promise<ModelCompatibility> {
  const engine = ExtensionManager.getInstance().getEngine(engineId) as
    | { prepareCoreSettings?: () => Promise<void> }
    | undefined
  await engine?.prepareCoreSettings?.()
  return coreCall('POST', `/models/${encodeURIComponent(engineId)}/check`, request)
}

/** Where the core keeps the shared store of managed models on this machine, and the room there. */
export function managedModelLocation(): Promise<ManagedModelLocation> {
  return coreCall('GET', '/managed-models/location')
}

/**
 * The curated models and NVIDIA notices of a descriptor the core has cached, by the id an
 * installation pins or a plan names. The core answers from its cache without the network; an id
 * it does not hold (404) or a core without managed runtimes (422) answers `null`, and the app shows
 * no curated list and says the notices were not reported.
 */
export async function describeDescriptor(descriptorId: string): Promise<DescriptorSummary | null> {
  try {
    return await coreCall<DescriptorSummary>(
      'GET',
      `/environments/descriptors/${encodeURIComponent(descriptorId)}`
    )
  } catch {
    return null
  }
}

export function defaultInstallDeps(): InstallDeps {
  return {
    fetch,
    check: checkManagedModel,
    location: managedModelLocation,
    existingSize: async (savePath) => {
      try {
        const stat = await fs.fileStat(savePath)
        return stat && !stat.isDirectory ? Number(stat.size) : null
      } catch {
        return null
      }
    },
    hasPartial: async (savePath) => {
      try {
        return (await fs.fileStat(`${savePath}.tmp`)) != null
      } catch {
        return false
      }
    },
    transfer: transferFiles,
    writeYaml: (savePath, data) => invoke<void>('write_yaml', { data, savePath }),
    emit: (event, payload) => events.emit(event, payload),
  }
}
