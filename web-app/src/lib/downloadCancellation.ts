import type { ServiceHub } from '@/services'
import { useDownloadStore } from '@/hooks/useDownloadStore'

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
 * binaries (`llamacpp*`) and MLX repos (`mlx*`) run through the download
 * extension and are cancelled there; model files go through the model
 * service's abort. The store is marked first so the row can offer a resume,
 * and so the stop event that follows is read as a cancel, not a failure.
 *
 * `id` and `name` are the same string for a model download; the panel keeps
 * both because the app update row does not.
 */
export function cancelDownload(
  download: { id: string; name: string },
  serviceHub: ServiceHub
): void {
  const { markResumableDownload, clearPausedDownload, clearResumeParams } =
    useDownloadStore.getState()
  for (const key of new Set([download.name, download.id])) {
    markDownloadCancellationRequested(key)
    markResumableDownload(key)
    clearPausedDownload(key)
    clearResumeParams(key)
  }
  if (download.id.startsWith('llamacpp') || download.id.startsWith('mlx')) {
    const downloadManager = window.core.extensionManager.getByName(
      '@janhq/download-extension'
    )
    downloadManager.cancelDownload(download.id)
  } else {
    void serviceHub.models().abortDownload(download.name)
  }
}
