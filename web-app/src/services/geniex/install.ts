/**
 * Downloading a GenieX model (openspec change `add-geniex-runtime`, spec `geniex-models`, "Файлы
 * модели качает клиент с проверкой"). The core never downloads GenieX models; the app does, with its
 * own downloader, under one row of the download panel:
 *
 * A GGUF model (`llama_cpp`, run on the chosen device):
 * 1. a gated repository without the person's Hugging Face token is refused before anything starts;
 * 2. the core's verdict on the device (`POST /models/geniex/check`): only `ok` downloads — the card
 *    sends the person to the provider page for an engine that is missing;
 * 3. room on the disk for what is still to download;
 * 4. one `download_files` task `geniex-<model>` for the file and, for vision, its projector, at
 *    `https://huggingface.co/<repo>/resolve/<revision>/<path>`, with resume, size and sha256. The
 *    token goes through the shared downloader, which attaches it only to Hugging Face URLs, and the
 *    Rust client drops it on the redirect to Hugging Face's CDN. A 401 or 403 removes the folder and
 *    becomes `GatedModelError`;
 * 5. the core checks the file by its path: a verdict other than `ok` removes the model's folder and
 *    says why;
 * 6. `model.yml` last, with the `geniex` block the core loads the model by: a curated model's
 *    abilities from conf's list, a Hugging Face model's from the check's metadata.
 *
 * An AI Hub bundle (`qairt`, NPU only, one per chip):
 * 1. the core's verdict on the variant (plugin, device, conf's chip, the oldest GenieX it names);
 * 2. room on the disk; 3. one task `geniex-<variant>` for the zip from Qualcomm's S3 (never a token:
 *    the downloader attaches one to Hugging Face hosts only), checked by size and sha256; 4. the zip
 *    unpacked into the variant's folder under the same task (`extract_zip`, zip-slip refused, the
 *    archive deleted); 5. the core checks the folder with conf's chip; 6. `model.yml` last.
 *
 * A folder without `model.yml` is not a model, so a download that failed or was cut off never lists
 * as one.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { DownloadEvent, events, fs, getJanDataFolderPath } from '@janhq/core'

import { isDownloadCancellationError } from '@/lib/downloadCancellation'
import { geniexDownloadId } from '@/lib/geniex/download-id'
import {
  downloadProxyConfig,
  isTransferValidationError,
  transferFiles,
  type TransferItem,
  type TransferOptions,
} from '@/services/diffusion/transfer'
import { GatedModelError, InsufficientModelSpaceError, underRoot } from '@/services/managed-models/models'

import { checkGeniexModel } from './core'
import type {
  GeniexCheckRequest,
  GeniexCheckResult,
  GeniexDevice,
  GeniexHubFile,
  GeniexHubModel,
  GeniexHubVariant,
} from './types'

/** The model cannot run here yet: the card leads to the provider page instead. */
export class GeniexNotReadyError extends Error {
  constructor(readonly check: GeniexCheckResult) {
    super(check.reason ?? `GenieX cannot run this model here (${check.verdict}).`)
    this.name = 'GeniexNotReadyError'
  }
}

/** The core refused the downloaded model; its folder is gone. */
export class GeniexModelRefusedError extends Error {
  constructor(readonly check: GeniexCheckResult) {
    super(check.reason ?? `GenieX cannot run the downloaded model (${check.verdict}).`)
    this.name = 'GeniexModelRefusedError'
  }
}

/** `FreeSpaceReport` of `src-tauri/src/core/downloads/disk.rs`: the data folder's volume. */
interface FreeSpaceReport {
  available: number | null
  headroom: number
}

/** What `extract_zip` answers. */
export interface ExtractReport {
  files: number
  bytes: number
}

export interface GeniexInstallDeps {
  check: (request: GeniexCheckRequest) => Promise<GeniexCheckResult>
  dataFolder: () => Promise<string>
  /** Size of a file (an absolute path), or null when it is not there. */
  existingSize: (savePath: string) => Promise<number | null>
  /** Whether a download of this file left a partial (`<file>.tmp`) behind. */
  hasPartial: (savePath: string) => Promise<boolean>
  /** Whether a bundle's folder already holds an unpacked bundle (its `geniex.json`). */
  isUnpacked: (folder: string) => Promise<boolean>
  freeSpace: () => Promise<FreeSpaceReport | null>
  transfer: (items: TransferItem[], taskId: string, options: TransferOptions) => Promise<void>
  /** Unpack `archive` into `outputDir` under `taskId`, deleting the archive; progress on the task's events. */
  extractZip: (
    archive: string,
    outputDir: string,
    taskId: string,
    onProgress?: (fraction: number) => void
  ) => Promise<ExtractReport>
  removeFolder: (path: string) => Promise<void>
  writeYaml: (savePath: string, data: unknown) => Promise<void>
  emit: (event: string, payload: unknown) => void
  /** Settings → Proxy, in the shape `download_files` takes; `undefined` when off. */
  proxy: () => Record<string, string | string[] | boolean> | undefined
}

export interface GeniexInstallRequest {
  model: GeniexHubModel
  /** A GGUF model: the device it is downloaded for (its default; the settings may change it). */
  device?: GeniexDevice
  /** A bundle model: the variant for this computer's chip. */
  variant?: GeniexHubVariant
  /** The person's Hugging Face token (Settings), if any; never sent anywhere but Hugging Face. */
  hfToken?: string
  onProgress?: (transferred: number, total: number) => void
}

/** The download's share of the row before unpacking takes the rest. */
const DOWNLOAD_SHARE = 0.9

const isRefusal = (error: unknown): boolean =>
  /HTTP status 40[13]\b/.test(error instanceof Error ? error.message : String(error))

const fileName = (path: string) => path.split('/').at(-1) ?? path

/** Downloads, checks and records one model; rejects before any download when it cannot run here. */
export async function installGeniexModel(
  request: GeniexInstallRequest,
  deps: GeniexInstallDeps = defaultGeniexInstallDeps()
): Promise<{ modelId: string }> {
  const { model } = request
  if (model.kind === 'qairt' || request.variant) {
    if (!request.variant) throw new Error(`GenieX: no bundle of ${model.model_id} fits this computer.`)
    return installBundle(request, request.variant, deps)
  }
  if (!model.gguf || !request.device) throw new Error(`GenieX: ${model.model_id} has no file to download.`)
  return installGguf(request, model.gguf, request.device, deps)
}

async function ensureRoom(deps: GeniexInstallDeps, root: string, bytes: number): Promise<void> {
  const space = await deps.freeSpace()
  if (space?.available != null && space.available - space.headroom < bytes) {
    throw new InsufficientModelSpaceError(root, bytes, Math.max(0, space.available - space.headroom))
  }
}

function progressEmitter(deps: GeniexInstallDeps, downloadId: string, request: GeniexInstallRequest) {
  return (transferred: number, total: number, percent: number) => {
    deps.emit(DownloadEvent.onFileDownloadUpdate, {
      modelId: downloadId,
      percent,
      size: { transferred, total },
      downloadType: 'Model',
    })
    request.onProgress?.(transferred, total)
  }
}

async function installGguf(
  request: GeniexInstallRequest,
  gguf: NonNullable<GeniexHubModel['gguf']>,
  device: GeniexDevice,
  deps: GeniexInstallDeps
): Promise<{ modelId: string }> {
  const { model } = request
  const token = request.hfToken || undefined
  if (gguf.gated && !token) throw new GatedModelError(gguf.repo)

  const check = await deps.check({ plugin: 'llama_cpp', device })
  if (check.verdict !== 'ok') throw new GeniexNotReadyError(check)

  const root = underRoot(await deps.dataFolder(), 'geniex', 'models', model.model_id)
  const files: GeniexHubFile[] = [gguf.file, ...(gguf.mmproj ? [gguf.mmproj] : [])]
  const savePathOf = (file: GeniexHubFile) => underRoot(root, fileName(file.path))
  const downloadId = geniexDownloadId(model.model_id)
  // A complete file is not fetched again; a partial one is resumed by the downloader.
  const pending: GeniexHubFile[] = []
  for (const file of files) {
    if ((await deps.existingSize(savePathOf(file))) !== file.size) pending.push(file)
  }
  const fresh: GeniexHubFile[] = []
  for (const file of pending) {
    if (!(await deps.hasPartial(savePathOf(file)))) fresh.push(file)
  }
  // A resumed download needs only what its partial lacks, which only the downloader can count.
  if (fresh.length > 0) await ensureRoom(deps, root, fresh.reduce((sum, file) => sum + file.size, 0))

  const total = files.reduce((sum, file) => sum + file.size, 0)
  const emitProgress = progressEmitter(deps, downloadId, request)
  try {
    if (pending.length > 0) {
      const proxy = deps.proxy()
      const items: TransferItem[] = pending.map((file) => ({
        url: `https://huggingface.co/${gguf.repo}/resolve/${gguf.revision}/${file.path}`,
        save_path: savePathOf(file),
        size: file.size,
        sha256: file.sha256,
        model_id: downloadId,
        resume_key: `geniex/${model.model_id}/${file.path}`,
        ...(proxy ? { proxy } : {}),
      }))
      try {
        await deps.transfer(items, downloadId, {
          resume: true,
          ...(token ? { hfToken: token } : {}),
          onProgress: (transferred, total) => {
            // Status-only events (`{ stage }`) carry no bytes; as progress they would rewind the bar.
            if (typeof transferred !== 'number' || typeof total !== 'number') return
            emitProgress(transferred, total, total > 0 ? transferred / total : 0)
          },
        })
      } catch (error) {
        if (!isRefusal(error)) throw error
        // A refusal is the person's to fix on Hugging Face: nothing of the model stays.
        await deps.removeFolder(root)
        throw new GatedModelError(gguf.repo)
      }
    }
    const fileCheck = await deps.check({ path: savePathOf(gguf.file), plugin: 'llama_cpp', device })
    if (fileCheck.verdict !== 'ok') {
      await deps.removeFolder(root)
      throw new GeniexModelRefusedError(fileCheck)
    }
    // Last: this file turns the folder into a model for the core and the extension.
    await deps.writeYaml(underRoot(root, 'model.yml'), ggufModelYml(model, gguf, device, fileCheck, total))
  } catch (error) {
    if (pending.length > 0) emitDownloadEnded(deps, downloadId, error)
    throw error
  }
  if (pending.length > 0) {
    deps.emit(DownloadEvent.onFileDownloadSuccess, {
      modelId: downloadId,
      downloadType: 'Model',
      size: { transferred: total, total },
    })
  }
  return { modelId: model.model_id }
}

/**
 * `model.yml` for a GGUF: the file (and its projector as `mmproj_path`, which the core reads before
 * the block's name), the name, the bytes, and the block the core loads the model by. A curated
 * model's abilities are conf's; a Hugging Face model's come from the core's reading of the header —
 * the context and whether a projector sits beside it. The header names no tool calling or thinking
 * mode, so neither is claimed for a Hugging Face model (rulings/app.md): the core would refuse tools
 * to it and the app keeps Agent mode off.
 */
function ggufModelYml(
  model: GeniexHubModel,
  gguf: NonNullable<GeniexHubModel['gguf']>,
  device: GeniexDevice,
  check: GeniexCheckResult,
  sizeBytes: number
): Record<string, unknown> {
  const metadata = check.metadata?.kind === 'gguf' ? check.metadata : undefined
  const abilities =
    model.origin === 'huggingface'
      ? {
          context_length: metadata?.max_context_tokens ?? model.context_length ?? DEFAULT_CONTEXT_LENGTH,
          tools: false,
          reasoning: false,
          vision: metadata?.vision ?? !!gguf.mmproj,
        }
      : {
          context_length: model.context_length ?? metadata?.max_context_tokens ?? DEFAULT_CONTEXT_LENGTH,
          tools: model.tools ?? false,
          reasoning: model.reasoning ?? false,
          vision: model.vision ?? false,
        }
  const file = fileName(gguf.file.path)
  const mmproj = gguf.mmproj ? fileName(gguf.mmproj.path) : undefined
  return {
    model_path: `geniex/models/${model.model_id}/${file}`,
    ...(mmproj ? { mmproj_path: `geniex/models/${model.model_id}/${mmproj}` } : {}),
    name: model.name,
    size_bytes: sizeBytes,
    geniex: {
      model_id: model.model_id,
      variant_id: model.model_id,
      plugin: 'llama_cpp',
      backend: device,
      repo: gguf.repo,
      revision: gguf.revision,
      file,
      ...(mmproj ? { mmproj } : {}),
      ...abilities,
      source: model.origin,
    },
  }
}

/** When neither the list nor the file's header says: what llama.cpp assumes too. */
const DEFAULT_CONTEXT_LENGTH = 4096

const BUNDLE_ARCHIVE = 'bundle.zip'

async function installBundle(
  request: GeniexInstallRequest,
  variant: GeniexHubVariant,
  deps: GeniexInstallDeps
): Promise<{ modelId: string }> {
  const { model } = request
  const check = await deps.check({
    plugin: 'qairt',
    device: 'npu',
    chip: variant.chip,
    ...(variant.min_runtime_version ? { min_runtime_version: variant.min_runtime_version } : {}),
  })
  if (check.verdict !== 'ok') throw new GeniexNotReadyError(check)

  const root = underRoot(await deps.dataFolder(), 'geniex', 'models', variant.id)
  const archive = underRoot(root, BUNDLE_ARCHIVE)
  const downloadId = geniexDownloadId(variant.id)
  const unpacked = await deps.isUnpacked(root)
  const pending = !unpacked && (await deps.existingSize(archive)) !== variant.bundle.size
  if (pending && !(await deps.hasPartial(archive))) {
    // The zip and what it unpacks to: the archive is deleted only once everything is out.
    await ensureRoom(deps, root, variant.bundle.size * 2)
  }

  const total = variant.bundle.size
  const emitProgress = progressEmitter(deps, downloadId, request)
  let sizeBytes = variant.bundle.size
  try {
    if (!unpacked) {
      if (pending) {
        const proxy = deps.proxy()
        const item: TransferItem = {
          url: variant.bundle.url,
          save_path: archive,
          size: variant.bundle.size,
          sha256: variant.bundle.sha256,
          model_id: downloadId,
          resume_key: `geniex/${variant.id}/${BUNDLE_ARCHIVE}`,
          ...(proxy ? { proxy } : {}),
        }
        // No token: the shared downloader attaches one to Hugging Face hosts only, and this is
        // Qualcomm's S3. Not even offered, so a change there cannot send it.
        await deps.transfer([item], downloadId, {
          resume: true,
          onProgress: (transferred, total) => {
            if (typeof transferred !== 'number' || typeof total !== 'number') return
            emitProgress(transferred, total, total > 0 ? (transferred / total) * DOWNLOAD_SHARE : 0)
          },
        })
      }
      // The same task: the panel's row moves on to the unpacking, and its Cancel stops it.
      const report = await deps.extractZip(archive, root, downloadId, (fraction) =>
        emitProgress(total, total, DOWNLOAD_SHARE + (1 - DOWNLOAD_SHARE) * fraction)
      )
      sizeBytes = report.bytes > 0 ? report.bytes : sizeBytes
    }
    const folderCheck = await deps.check({ path: root, plugin: 'qairt', device: 'npu', chip: variant.chip })
    if (folderCheck.verdict !== 'ok') {
      await deps.removeFolder(root)
      throw new GeniexModelRefusedError(folderCheck)
    }
    await deps.writeYaml(underRoot(root, 'model.yml'), bundleModelYml(model, variant, folderCheck, sizeBytes))
  } catch (error) {
    if (!unpacked) emitDownloadEnded(deps, downloadId, error)
    throw error
  }
  if (!unpacked) {
    deps.emit(DownloadEvent.onFileDownloadSuccess, {
      modelId: downloadId,
      downloadType: 'Model',
      size: { transferred: total, total },
    })
  }
  return { modelId: variant.id }
}

/** `model.yml` for a bundle: its folder is the model, the block names the chip and the archive. */
function bundleModelYml(
  model: GeniexHubModel,
  variant: GeniexHubVariant,
  check: GeniexCheckResult,
  sizeBytes: number
): Record<string, unknown> {
  const metadata = check.metadata?.kind === 'qairt' ? check.metadata : undefined
  return {
    model_path: `geniex/models/${variant.id}`,
    name: model.name,
    size_bytes: sizeBytes,
    geniex: {
      model_id: model.model_id,
      variant_id: variant.id,
      plugin: 'qairt',
      backend: 'npu',
      chip: variant.chip,
      bundle_url: variant.bundle.url,
      precision: metadata?.precision ?? variant.precision,
      context_length: model.context_length ?? metadata?.max_context_tokens ?? DEFAULT_CONTEXT_LENGTH,
      tools: model.tools ?? false,
      reasoning: model.reasoning ?? false,
      vision: model.vision ?? false,
      source: model.origin === 'huggingface' ? 'huggingface' : 'curated',
    },
  }
}

/** End the row and its toasts the way a LiteRT-LM variant's download ends them. */
function emitDownloadEnded(deps: GeniexInstallDeps, downloadId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  if (isDownloadCancellationError(error) || /^Extraction cancelled/.test(message)) {
    deps.emit(DownloadEvent.onFileDownloadStopped, { modelId: downloadId, downloadType: 'Model' })
  } else if (isTransferValidationError(error)) {
    deps.emit(DownloadEvent.onModelValidationFailed, {
      modelId: downloadId,
      downloadType: 'Model',
      error: message,
      reason: 'validation_failed',
    })
  } else {
    deps.emit(DownloadEvent.onFileDownloadError, { modelId: downloadId, downloadType: 'Model', error: message })
  }
}

/** Unpack through the Rust command, following its progress on the download's own events. */
async function extractZipWithProgress(
  archive: string,
  outputDir: string,
  taskId: string,
  onProgress?: (fraction: number) => void
): Promise<ExtractReport> {
  const unlisten = await listen<{ transferred?: number; total?: number }>(`download-${taskId}`, (event) => {
    const { transferred, total } = event.payload
    if (typeof transferred === 'number' && typeof total === 'number' && total > 0) onProgress?.(transferred / total)
  })
  try {
    return await invoke<ExtractReport>('extract_zip', { archive, outputDir, taskId, removeArchive: true })
  } finally {
    unlisten()
  }
}

export function defaultGeniexInstallDeps(): GeniexInstallDeps {
  return {
    check: checkGeniexModel,
    dataFolder: getJanDataFolderPath,
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
    isUnpacked: async (folder) => {
      try {
        return (await fs.fileStat(`${folder}/geniex.json`)) != null
      } catch {
        return false
      }
    },
    // The command `downloadPreflight.ts` asks too; an unknown answer leaves the check to the downloader.
    freeSpace: () => invoke<FreeSpaceReport>('get_download_free_space').catch(() => null),
    transfer: transferFiles,
    extractZip: extractZipWithProgress,
    removeFolder: async (path) => {
      if (await fs.existsSync(path)) await fs.rm(path)
    },
    writeYaml: (savePath, data) => invoke<void>('write_yaml', { data, savePath }),
    emit: (event, payload) => events.emit(event, payload),
    proxy: downloadProxyConfig,
  }
}
