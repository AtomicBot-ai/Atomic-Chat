import { useCallback } from 'react'
import { toast } from 'sonner'

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  audioDownloadTaskId,
  audioWireId,
  downloadAudioModel,
  isAudioQuantOnDisk,
} from '@/lib/audio/models'
import { isDownloadCancellationError } from '@/lib/downloadCancellation'
import {
  recommendedAudioQuant,
  type AudioCatalogModel,
  type AudioCatalogQuant,
} from '@/services/audio-catalog-registry'
import { cancelTransfer } from '@/services/diffusion/transfer'
import { useAudioGenerationStore } from '@/stores/audio-generation-store'

export type AudioModelState = {
  quant: AudioCatalogQuant
  /** The file is on disk, whole. */
  installed: boolean
  downloading: boolean
  /** 0..1 */
  progress: number
  download: () => Promise<void>
  cancelDownload: () => Promise<void>
  remove: () => Promise<void>
}

/**
 * Everything a picker row needs about one catalog model. Progress comes from
 * `useDownloadStore`, so the row and the download panel agree. A first download
 * also installs the engine when it is missing and this computer has a build: a
 * model on disk with nothing to run it is not what the user asked for.
 */
export function useAudioModel(model: AudioCatalogModel): AudioModelState {
  const { t } = useTranslation()
  const quant = recommendedAudioQuant(model)
  const taskId = audioDownloadTaskId(audioWireId(model, quant))
  const modelFiles = useAudioGenerationStore((state) => state.modelFiles)
  const entry = useDownloadStore((state) => state.downloads[taskId])
  const huggingfaceToken = useGeneralSetting((state) => state.huggingfaceToken)

  const download = useCallback(async () => {
    const store = useAudioGenerationStore.getState()
    if (store.status?.install.state !== 'installed' && store.hostBackendId) {
      void store.installEngine()
    }
    try {
      await downloadAudioModel(model, quant, { hfToken: huggingfaceToken })
      await useAudioGenerationStore.getState().refreshModelFiles()
    } catch (error) {
      if (isDownloadCancellationError(error)) return
      console.error('[audios] model download failed:', error)
      toast.error(t('audios:model.downloadFailed', { name: model.name }), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [huggingfaceToken, model, quant, t])

  const cancelDownload = useCallback(async () => {
    await cancelTransfer(taskId)
  }, [taskId])

  const remove = useCallback(
    () => useAudioGenerationStore.getState().removeModel(model.id),
    [model.id]
  )

  return {
    quant,
    installed: isAudioQuantOnDisk(quant, modelFiles),
    downloading: Boolean(entry),
    progress: entry?.progress ?? 0,
    download,
    cancelDownload,
    remove,
  }
}
