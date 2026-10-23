import { IconCheck } from '@tabler/icons-react'
import { toast } from 'sonner'

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useImageForm } from '@/hooks/useImageForm'
import {
  downloadArtifact,
  resolveDiffusionDownloadTaskId,
} from '@/lib/diffusion/models'
import { PRISM_PROVIDER } from '@/lib/model-setup'
import type { ServiceHub } from '@/services'
import {
  prismSetupDeps,
  verifyPrismDownload,
} from '@/services/model-setup/prism-setup'
import { useImageGenerationStore } from '@/stores/image-generation-store'

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * Resume a paused download: an image or video checkpoint through its catalog
 * entry, a chat-model file through the parameters its download started with
 * (ATO-154). One place for it, so the download panel, the Downloads page and
 * the cards that offer the model resume the same way.
 *
 * A download brought back after a relaunch (`lib/interrupted-downloads`) has
 * its parameters without the Hugging Face token, which is never stored with
 * them: the token in Settings is used, as a fresh download from the Hub would.
 */
export function resumeDownload(
  download: { id: string; name: string },
  { serviceHub, t }: { serviceHub: ServiceHub; t: Translate }
): void {
  const { resumeParams, clearPausedDownload, markResumableDownload } =
    useDownloadStore.getState()
  if (useDownloadStore.getState().downloads[download.id]?.recoveryBlocked)
    return
  const imageCatalog = useImageGenerationStore.getState().catalog
  const huggingfaceToken = useGeneralSetting.getState().huggingfaceToken

  const diffusionTarget = imageCatalog
    ? resolveDiffusionDownloadTaskId(imageCatalog, download.id)
    : null
  if (diffusionTarget) {
    clearPausedDownload(download.id)
    if (download.id !== download.name) clearPausedDownload(download.name)
    markResumableDownload(download.id)
    toast.success(t('common:toast.downloadResumed.title'), {
      icon: (
        <IconCheck
          size={16}
          className="text-blue-500 dark:text-blue-400"
          aria-hidden
        />
      ),
      duration: 2500,
    })
    void downloadArtifact(diffusionTarget.family, diffusionTarget.quant.id, {
      resume: true,
      hfToken: huggingfaceToken,
      workflow: useImageForm.getState().workflow,
    })
      // Nothing else re-lists the models folder for a resume started
      // here, so the finished model kept reading as "not downloaded".
      .then(() => useImageGenerationStore.getState().refreshModelFiles())
      .catch((error) => {
        // downloadArtifact emits the ordinary transfer-error event first;
        // that listener owns the existing user-facing failure path.
        console.error('[DownloadManagement] diffusion resume failed:', error)
      })
    return
  }

  const params = resumeParams[download.id] ?? resumeParams[download.name]
  if (!params) {
    // Nothing here can resume it: a checkpoint the catalog cannot resolve
    // (not loaded, or no longer listing it), or a file whose parameters are
    // gone. Clearing only the pause left a row that looked running with no
    // transfer behind it, which Cancel could not stop and the next launch
    // brought back. Drop the row the way Cancel drops a paused one (which also
    // drops its `lib/interrupted-downloads` record); the partial files stay,
    // marked resumable, so the model's own Download picks up from them.
    const store = useDownloadStore.getState()
    for (const key of new Set([download.id, download.name])) {
      store.clearPausedDownload(key)
      store.clearResumeParams(key)
      store.removeDownload(key)
      store.removeLocalDownloadingModel(key)
      store.clearDownloadOrigin(key)
      store.markResumableDownload(key)
    }
    toast.error(t('common:toast.downloadNotResumable.title'), {
      description: t('common:toast.downloadNotResumable.description', {
        item: download.name,
      }),
    })
    return
  }
  // Keep Pause visible until the previous model importer has unwound.
  markResumableDownload(download.id)
  const { modelPath, mmprojPath, hfToken, skipVerification, ...pullOptions } =
    params
  void serviceHub
    .models()
    .pullModelWithMetadata(
      download.id,
      modelPath,
      mmprojPath,
      huggingfaceToken || hfToken,
      skipVerification ?? true,
      true,
      pullOptions
    )
    .then(async (refusal) => {
      // A Bonsai file ends as the Hub's download does: kept only if the
      // core says PrismML runs the file now on disk.
      if (pullOptions.provider !== PRISM_PROVIDER || refusal) return
      if (useDownloadStore.getState().pausedDownloads.has(download.id)) return
      const result = await verifyPrismDownload(
        download.id,
        prismSetupDeps(serviceHub)
      )
      if (result.outcome === 'rejected')
        toast.error(t('hub:prismModelRejected'), {
          description: result.reason,
        })
    })
    .catch((error) => {
      console.error('[DownloadManagement] resume failed:', error)
    })
}
