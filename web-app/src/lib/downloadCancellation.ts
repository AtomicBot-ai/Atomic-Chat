import type { ServiceHub } from '@/services'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { isDecisionDownloadTaskId } from '@/lib/decision/models'
import { isEmbeddingDownloadTaskId } from '@/lib/embedding/models'
import { isDiffusionModelDownloadTaskId } from '@/lib/diffusion/models'
import { isManagedDownloadId } from '@/lib/managed-engine/download-id'
import { isFoundryLocalDownloadId } from '@/lib/foundry-local/download-id'
import { isLiteRtLmDownloadId } from '@/lib/litert-lm/download-id'
import { isDiffusionEngineTaskId } from '@/services/diffusion/engine'
import { cancelTransfer } from '@/services/diffusion/transfer'
import { cancelEngineBuildDownload } from '@/services/engine-builds/core'
import { isEngineBuildTaskId } from '@/services/engine-builds/install'
import { isEngineUpdateTaskId } from '@/services/engines/update'

const CANCEL_TTL_MS = 15000

const requestedCancellations = new Map<string, number>()

/** Backend and extension transports do not share one cancellation error type. */
export function isDownloadCancellationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /abort|aborted|cancel|cancelled|canceled|stop|stopped|interrupt/i.test(
    message
  )
}

export function markDownloadCancellationRequested(id: string) {
  requestedCancellations.set(id, Date.now())
}

export function wasDownloadCancellationRequested(id: string): boolean {
  const requestedAt = requestedCancellations.get(id)
  if (!requestedAt) return false

  if (Date.now() - requestedAt > CANCEL_TTL_MS) {
    requestedCancellations.delete(id)
    return false
  }

  return true
}

export function clearDownloadCancellationRequested(id: string) {
  requestedCancellations.delete(id)
}

/**
 * Stop a download the way the bottom-right panel does.
 *
 * One place for the branching, so a Cancel offered anywhere else (the
 * composer's reply widget) stops the same transfer the panel would: backend
 * binaries (`llamacpp*`), MLX repos (`mlx*`) and diffusion artifacts run
 * through the download extension and are cancelled there; chat-model files
 * go through the model service's abort; managed models (`managed-*`, TensorRT-LLM and vLLM),
 * Foundry Local variants (`foundry-local-*`), LiteRT-LM variants (`litert-lm-*`),
 * decision models (`decision-*`) and embedding models (`embedding-*`) are a
 * plain transfer of their files, stopped by task id. The media engine
 * (`diffusion-backend-*`) is downloaded by the core, which stops it by task id
 * too, as are the other engine builds it installs (`engine-build-*`, MLX) and
 * every engine update it applies (`engine-update-*`).
 * The store is marked first so the row
 * can offer a resume, and so the stop event that follows is read as a cancel,
 * not a failure.
 *
 * `id` and `name` are the same string for a model download; the panel keeps
 * both because the app update row does not.
 */
export function cancelDownload(
  download: { id: string; name: string },
  serviceHub: ServiceHub
): void {
  const {
    markResumableDownload,
    clearPausedDownload,
    clearResumeParams,
    dismissDownload,
    clearDownloadOrigin,
    resumeParams,
  } = useDownloadStore.getState()
  const modelRequest =
    !!(resumeParams[download.id] || resumeParams[download.name]) ||
    !(
      isDiffusionEngineTaskId(download.id) ||
      isEngineBuildTaskId(download.id) ||
      isEngineUpdateTaskId(download.id) ||
      isDiffusionModelDownloadTaskId(download.id) ||
      isDecisionDownloadTaskId(download.id) ||
      isEmbeddingDownloadTaskId(download.id) ||
      isManagedDownloadId(download.id) ||
      isFoundryLocalDownloadId(download.id) ||
      download.id.startsWith('llamacpp') ||
      download.id.startsWith('mlx')
    )
  const store = useDownloadStore.getState()
  const keys = new Set([download.name, download.id])
  // Pause already stopped the transfer, so no stop event will come to clear a
  // paused row: a paused checkpoint's row stayed in the panel for good, and a
  // download brought back after a relaunch would come back again.
  const paused = [...keys].some((key) => store.pausedDownloads.has(key))
  for (const key of keys) {
    markDownloadCancellationRequested(key)
    markResumableDownload(key)
    if (modelRequest) {
      // Cancel is distinct from Pause: hide now, suppress late events/startup
      // discovery, and retain the source mapping only for an explicit retry.
      dismissDownload(key)
      clearDownloadOrigin(key)
    } else {
      clearPausedDownload(key)
      clearResumeParams(key)
      if (paused) {
        store.removeDownload(key)
        store.removeLocalDownloadingModel(key)
        clearDownloadOrigin(key)
      }
    }
  }
  // A checkpoint's transfer has nothing left to stop. The model service's
  // abort still runs for a chat-model file: its stop event reports the cancel.
  if (paused && isDiffusionModelDownloadTaskId(download.id)) return
  if (
    isDiffusionEngineTaskId(download.id) ||
    isEngineBuildTaskId(download.id) ||
    isEngineUpdateTaskId(download.id)
  ) {
    void cancelEngineBuildDownload(download.id)
  } else if (
    isDiffusionModelDownloadTaskId(download.id) ||
    isDecisionDownloadTaskId(download.id) ||
    isEmbeddingDownloadTaskId(download.id) ||
    isManagedDownloadId(download.id) ||
    isFoundryLocalDownloadId(download.id) ||
    isLiteRtLmDownloadId(download.id)
  ) {
    void cancelTransfer(download.id)
  } else if (resumeParams[download.id] || resumeParams[download.name]) {
    // Model ids beginning with `mlx` still need the engine's provider/task-id mapping.
    void serviceHub.models().abortDownload(download.name)
  } else if (
    download.id.startsWith('llamacpp') ||
    download.id.startsWith('mlx')
  ) {
    const downloadManager = window.core.extensionManager.getByName(
      '@janhq/download-extension'
    )
    downloadManager.cancelDownload(download.id)
  } else {
    void serviceHub.models().abortDownload(download.name)
  }
}
