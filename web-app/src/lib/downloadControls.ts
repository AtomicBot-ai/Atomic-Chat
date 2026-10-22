import type { ServiceHub } from '@/services'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { isDecisionDownloadTaskId } from '@/lib/decision/models'
import { isDiffusionModelDownloadTaskId } from '@/lib/diffusion/models'
import { isEmbeddingDownloadTaskId } from '@/lib/embedding/models'
import { isFoundryLocalDownloadId } from '@/lib/foundry-local/download-id'
import { isManagedDownloadId } from '@/lib/managed-engine/download-id'
import { isDiffusionEngineTaskId } from '@/services/diffusion/engine'
import { cancelTransfer } from '@/services/diffusion/transfer'
import { isEngineBuildTaskId } from '@/services/engine-builds/install'
import { isEngineUpdateTaskId } from '@/services/engines/update'

/**
 * Whether a download can be paused and resumed later. Shared by the download
 * panel and the first-run flow, so both offer Pause on the same rows.
 *
 * ATO-154: pause/resume is only offered for resumable model (GGUF) downloads.
 * Backend-binary downloads (`llamacpp*`) and MLX repos (`mlx-community/*`,
 * which start with `mlx`) get cancel-only, matching Jan's gating.
 * Decision and embedding models resume from their Hub or settings card,
 * not from here.
 * Engine updates (`engine-update-*`) are the core's to stop, cancel-only.
 * Managed models are cancel-only too: Download again in the Hub resumes
 * from the files on disk (change add-tensorrt-llm-model-hub, design D6);
 * so are Foundry Local variants (change add-foundry-local).
 */
export function isPausableDownload(id: string): boolean {
  return (
    !id.startsWith('llamacpp') &&
    !isDiffusionEngineTaskId(id) &&
    !isEngineBuildTaskId(id) &&
    !isEngineUpdateTaskId(id) &&
    !id.startsWith('mlx') &&
    !isDecisionDownloadTaskId(id) &&
    !isEmbeddingDownloadTaskId(id) &&
    !isManagedDownloadId(id) &&
    !isFoundryLocalDownloadId(id)
  )
}

/**
 * Stops a download so that it can be resumed: the row stays, marked paused
 * and resumable, and the transfer is aborted. `resumeDownload`
 * (`lib/downloadResume`) picks it up again.
 */
export function pauseDownload(
  download: { id: string; name: string },
  serviceHub: ServiceHub
): void {
  const { markPausedDownload, markResumableDownload } =
    useDownloadStore.getState()
  markPausedDownload(download.id)
  markResumableDownload(download.id)
  if (download.id !== download.name) {
    markPausedDownload(download.name)
    markResumableDownload(download.name)
  }
  if (isDiffusionModelDownloadTaskId(download.id)) {
    void cancelTransfer(download.id)
  } else {
    void serviceHub.models().abortDownload(download.name)
  }
}
