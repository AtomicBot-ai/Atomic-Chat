import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'

import {
  VOICE_MMPROJ_URL,
  VOICE_MODEL_BYTES,
  VOICE_MODEL_ID,
  VOICE_MODEL_URL,
  VOICE_PROVIDER,
} from '@/constants/voice'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { markDownloadCancellationRequested } from '@/lib/downloadCancellation'
import { releaseVoiceEngine } from '@/lib/voice/engine'
import { markSilentImport } from '@/utils/backgroundImports'

export type VoiceModelState = {
  installed: boolean
  downloading: boolean
  /** 0..1 */
  progress: number
  /** Bytes transferred so far, when the download reports them. */
  currentBytes: number
  totalBytes: number
  download: () => Promise<void>
  cancelDownload: () => void
  remove: () => Promise<void>
}

/**
 * Everything the UI needs to know about the voice model.
 *
 * Purely derived — the model list lives in `useModelProvider` and progress in
 * `useDownloadStore`, so this hook owns no state of its own and both the setup
 * dialog and the settings panel stay in sync for free.
 */
export function useVoiceModel(): VoiceModelState {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()

  const providers = useModelProvider((state) => state.providers)
  const downloads = useDownloadStore((state) => state.downloads)
  const localDownloadingModels = useDownloadStore(
    (state) => state.localDownloadingModels
  )
  const resumableDownloads = useDownloadStore((state) => state.resumableDownloads)
  const addLocalDownloadingModel = useDownloadStore(
    (state) => state.addLocalDownloadingModel
  )
  const removeLocalDownloadingModel = useDownloadStore(
    (state) => state.removeLocalDownloadingModel
  )
  const clearResumableDownload = useDownloadStore(
    (state) => state.clearResumableDownload
  )
  const markResumableDownload = useDownloadStore(
    (state) => state.markResumableDownload
  )
  const huggingfaceToken = useGeneralSetting((state) => state.huggingfaceToken)

  const installed = useMemo(
    () =>
      providers.some(
        (provider) =>
          provider.provider === VOICE_PROVIDER &&
          provider.models.some((model) => model.id === VOICE_MODEL_ID)
      ),
    [providers]
  )

  const progressEntry = downloads[VOICE_MODEL_ID]
  const downloading =
    localDownloadingModels.has(VOICE_MODEL_ID) || Boolean(progressEntry)

  const download = useCallback(async () => {
    clearResumableDownload(VOICE_MODEL_ID)
    addLocalDownloadingModel(VOICE_MODEL_ID)
    // Without this, `DataProvider`'s onModelImported handler would switch the
    // active chat model to Voxtral the moment the download lands.
    markSilentImport(VOICE_MODEL_ID)

    try {
      await serviceHub
        .models()
        .pullModelWithMetadata(
          VOICE_MODEL_ID,
          VOICE_MODEL_URL,
          VOICE_MMPROJ_URL,
          huggingfaceToken,
          false,
          resumableDownloads.has(VOICE_MODEL_ID)
        )
    } catch (error) {
      // If the pull rejects before any DownloadEvent fires, the global listener
      // never clears `localDownloadingModels` and the button sticks.
      console.error('[voice] voice model download failed:', error)
      removeLocalDownloadingModel(VOICE_MODEL_ID)
      markResumableDownload(VOICE_MODEL_ID)
      toast.error(t('common:voiceInput.setup.model.failed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [
    addLocalDownloadingModel,
    clearResumableDownload,
    huggingfaceToken,
    markResumableDownload,
    removeLocalDownloadingModel,
    resumableDownloads,
    serviceHub,
    t,
  ])

  const cancelDownload = useCallback(() => {
    markDownloadCancellationRequested(VOICE_MODEL_ID)
    markResumableDownload(VOICE_MODEL_ID)
    void serviceHub.models().abortDownload(VOICE_MODEL_ID)
  }, [markResumableDownload, serviceHub])

  const remove = useCallback(async () => {
    // Stop the server before deleting the files it has mmapped.
    await releaseVoiceEngine()
    await serviceHub.models().deleteModel(VOICE_MODEL_ID, VOICE_PROVIDER)
  }, [serviceHub])

  return {
    installed,
    downloading,
    progress: progressEntry?.progress ?? 0,
    currentBytes: progressEntry?.current ?? 0,
    totalBytes: progressEntry?.total || VOICE_MODEL_BYTES,
    download,
    cancelDownload,
    remove,
  }
}
