/**
 * Downloading a LiteRT-LM variant (openspec change `add-litert-lm-runtime`, spec `litert-lm-models`,
 * "Файл варианта качает клиент с проверкой"). The core never downloads LiteRT-LM models; the app
 * does, with its own downloader, under one row of the download panel:
 *
 * 1. a gated repository without the person's Hugging Face token is refused before anything starts;
 * 2. the core's verdict on the variant (`POST /models/litert-lm/check`): only `ok` downloads — the
 *    card sends the person to the provider page for an engine or accelerator that is missing;
 * 3. room on the disk for what is still to download;
 * 4. one `download_files` task `litert-lm-<variant>` for the file at
 *    `https://huggingface.co/<repo>/resolve/<revision>/<path>`, with resume, size and sha256. The
 *    token goes through the shared downloader, which attaches it only to Hugging Face URLs, and the
 *    Rust client drops it on the redirect to Hugging Face's CDN. A 401 or 403 removes the folder and
 *    becomes `GatedModelError`;
 * 5. the core checks the file by its path: a verdict other than `ok` or `accelerator-not-prepared`
 *    removes the variant's folder and says why;
 * 6. `model.yml` last, with the `litert_lm` block the core loads the variant by: a curated model's
 *    abilities from conf's list, a Hugging Face model's from the check's metadata. A folder without
 *    it is not a model, so a download that failed or was cut off never lists as one.
 */

import { invoke } from '@tauri-apps/api/core'
import { DownloadEvent, events, fs, getJanDataFolderPath } from '@janhq/core'

import { isDownloadCancellationError } from '@/lib/downloadCancellation'
import { liteRtLmDownloadId } from '@/lib/litert-lm/download-id'
import { liteRtLmVariantLabel } from '@/lib/litert-lm/hub'
import {
  downloadProxyConfig,
  isTransferValidationError,
  transferFiles,
  type TransferItem,
  type TransferOptions,
} from '@/services/diffusion/transfer'
import {
  GatedModelError,
  InsufficientModelSpaceError,
  underRoot,
} from '@/services/managed-models/models'

import { checkLiteRtLmModel } from './core'
import type {
  LiteRtLmCheckRequest,
  LiteRtLmCheckResult,
  LiteRtLmHubModel,
  LiteRtLmHubVariant,
} from './types'

/** The variant cannot run here yet: the card leads to the provider page instead. */
export class LiteRtLmNotReadyError extends Error {
  constructor(readonly check: LiteRtLmCheckResult) {
    super(check.reason ?? `LiteRT-LM cannot run this variant here (${check.verdict}).`)
    this.name = 'LiteRtLmNotReadyError'
  }
}

/** The core refused the downloaded file; its folder is gone. */
export class LiteRtLmFileRefusedError extends Error {
  constructor(readonly check: LiteRtLmCheckResult) {
    super(check.reason ?? `LiteRT-LM cannot run the downloaded file (${check.verdict}).`)
    this.name = 'LiteRtLmFileRefusedError'
  }
}

/** `FreeSpaceReport` of `src-tauri/src/core/downloads/disk.rs`: the data folder's volume. */
interface FreeSpaceReport {
  available: number | null
  headroom: number
}

export interface LiteRtLmInstallDeps {
  check: (request: LiteRtLmCheckRequest) => Promise<LiteRtLmCheckResult>
  dataFolder: () => Promise<string>
  /** Size of a file (an absolute path), or null when it is not there. */
  existingSize: (savePath: string) => Promise<number | null>
  /** Whether a download of this file left a partial (`<file>.tmp`) behind. */
  hasPartial: (savePath: string) => Promise<boolean>
  freeSpace: () => Promise<FreeSpaceReport | null>
  transfer: (items: TransferItem[], taskId: string, options: TransferOptions) => Promise<void>
  removeFolder: (path: string) => Promise<void>
  writeYaml: (savePath: string, data: unknown) => Promise<void>
  emit: (event: string, payload: unknown) => void
  /** Settings → Proxy, in the shape `download_files` takes; `undefined` when off. */
  proxy: () => Record<string, string | string[] | boolean> | undefined
}

export interface LiteRtLmInstallRequest {
  model: LiteRtLmHubModel
  variant: LiteRtLmHubVariant
  /** The person's Hugging Face token (Settings), if any. */
  hfToken?: string
  onProgress?: (transferred: number, total: number) => void
}

/** Verdicts a downloaded file is kept with: an NPU file waits for its accelerator. */
const KEPT_VERDICTS: ReadonlySet<string> = new Set(['ok', 'accelerator-not-prepared'])

const isRefusal = (error: unknown): boolean =>
  /HTTP status 40[13]\b/.test(error instanceof Error ? error.message : String(error))

const fileName = (path: string) => path.split('/').at(-1) ?? path

/** `model.yml`: the file, the name, the bytes, and the block the core loads the variant by. */
function modelYml(
  model: LiteRtLmHubModel,
  variant: LiteRtLmHubVariant,
  check: LiteRtLmCheckResult
): Record<string, unknown> {
  const metadata = check.metadata
  const abilities =
    model.origin === 'huggingface' && metadata
      ? {
          ...(metadata.max_context_tokens ? { context_length: metadata.max_context_tokens } : {}),
          tools: metadata.function_calling,
          reasoning: metadata.thinking,
          vision: metadata.modalities.includes('vision'),
        }
      : {
          ...(model.context_length ? { context_length: model.context_length } : {}),
          tools: model.tools ?? false,
          reasoning: model.reasoning ?? false,
          vision: model.vision ?? false,
        }
  return {
    model_path: `litert-lm/models/${variant.id}/${fileName(variant.file.path)}`,
    name: `${model.name} (${liteRtLmVariantLabel(variant)})`,
    size_bytes: variant.file.size,
    litert_lm: {
      model_id: model.model_id,
      variant_id: variant.id,
      backend: variant.backend,
      ...(variant.npu ? { npu: variant.npu } : {}),
      repo: model.repo,
      revision: model.revision,
      file: variant.file.path,
      ...abilities,
      source: model.origin,
    },
  }
}

/** Downloads, checks and records one variant; rejects before any download when it cannot run here. */
export async function installLiteRtLmVariant(
  request: LiteRtLmInstallRequest,
  deps: LiteRtLmInstallDeps = defaultLiteRtLmInstallDeps()
): Promise<{ modelId: string }> {
  const { model, variant } = request
  const token = request.hfToken || undefined
  if (model.gated && !token) throw new GatedModelError(model.repo)

  const check = await deps.check({
    backend: variant.backend,
    ...(variant.npu ? { npu: variant.npu } : {}),
    ...(variant.min_runtime_version ? { min_runtime_version: variant.min_runtime_version } : {}),
  })
  if (check.verdict !== 'ok') throw new LiteRtLmNotReadyError(check)

  const root = underRoot(await deps.dataFolder(), 'litert-lm', 'models', variant.id)
  const savePath = underRoot(root, fileName(variant.file.path))
  const downloadId = liteRtLmDownloadId(variant.id)
  // A complete file is not fetched again; a partial one is resumed by the downloader.
  const pending = (await deps.existingSize(savePath)) !== variant.file.size
  if (pending && !(await deps.hasPartial(savePath))) {
    // A resumed download needs only what its partial lacks, which only the downloader can count.
    const space = await deps.freeSpace()
    if (space?.available != null && space.available - space.headroom < variant.file.size) {
      throw new InsufficientModelSpaceError(root, variant.file.size, Math.max(0, space.available - space.headroom))
    }
  }

  try {
    if (pending) {
      const proxy = deps.proxy()
      const item: TransferItem = {
        url: `https://huggingface.co/${model.repo}/resolve/${model.revision}/${variant.file.path}`,
        save_path: savePath,
        size: variant.file.size,
        sha256: variant.file.sha256,
        model_id: downloadId,
        resume_key: `litert-lm/${variant.id}/${variant.file.path}`,
        ...(proxy ? { proxy } : {}),
      }
      try {
        await deps.transfer([item], downloadId, {
          resume: true,
          ...(token ? { hfToken: token } : {}),
          onProgress: (transferred, total) => {
            // Status-only events (`{ stage }`) carry no bytes; as progress they would rewind the bar.
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
      } catch (error) {
        if (!isRefusal(error)) throw error
        // A refusal is the person's to fix on Hugging Face: nothing of the variant stays.
        await deps.removeFolder(root)
        throw new GatedModelError(model.repo)
      }
    }
    const fileCheck = await deps.check({
      path: savePath,
      backend: variant.backend,
      ...(variant.npu ? { npu: variant.npu } : {}),
    })
    if (!KEPT_VERDICTS.has(fileCheck.verdict)) {
      await deps.removeFolder(root)
      throw new LiteRtLmFileRefusedError(fileCheck)
    }
    // Last: this file turns the folder into a model for the core and the extension.
    await deps.writeYaml(underRoot(root, 'model.yml'), modelYml(model, variant, fileCheck))
  } catch (error) {
    if (pending) emitDownloadEnded(deps, downloadId, error)
    throw error
  }
  if (pending) {
    deps.emit(DownloadEvent.onFileDownloadSuccess, {
      modelId: downloadId,
      downloadType: 'Model',
      size: { transferred: variant.file.size, total: variant.file.size },
    })
  }
  return { modelId: variant.id }
}

/** End the row and its toasts the way a Foundry Local variant's download ends them. */
function emitDownloadEnded(deps: LiteRtLmInstallDeps, downloadId: string, error: unknown): void {
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
    deps.emit(DownloadEvent.onFileDownloadError, { modelId: downloadId, downloadType: 'Model', error: message })
  }
}

export function defaultLiteRtLmInstallDeps(): LiteRtLmInstallDeps {
  return {
    check: checkLiteRtLmModel,
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
    // The command `downloadPreflight.ts` asks too; an unknown answer leaves the check to the downloader.
    freeSpace: () => invoke<FreeSpaceReport>('get_download_free_space').catch(() => null),
    transfer: transferFiles,
    removeFolder: async (path) => {
      if (await fs.existsSync(path)) await fs.rm(path)
    },
    writeYaml: (savePath, data) => invoke<void>('write_yaml', { data, savePath }),
    emit: (event, payload) => events.emit(event, payload),
    proxy: downloadProxyConfig,
  }
}
