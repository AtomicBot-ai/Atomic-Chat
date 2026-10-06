import { IconX } from '@tabler/icons-react'
import { memo, useCallback, useState } from 'react'

import { Button } from '@/components/ui/button'
import { TensorrtVerdict } from '@/containers/hub/TensorrtVerdict'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  cancelDownload,
  isDownloadCancellationError,
  wasDownloadCancellationRequested,
} from '@/lib/downloadCancellation'
import type { CatalogModel } from '@/services/models/types'
import { installTensorrtModel, tensorrtDownloadId } from '@/services/tensorrt-llm/models'
import { verdictFromError, type TensorrtVerdict as Verdict } from '@/services/tensorrt-llm/verdict'

/**
 * "Download" for a TensorRT-LLM model the core said runs here (change `add-tensorrt-llm-model-hub`,
 * design D6): the same `installTensorrtModel` the provider page used, at the revision the core
 * checked. Its progress and its Cancel are the download panel's row (`tensorrtDownloadId`); a
 * download cancelled or cut off is resumed by pressing Download again.
 */
export const TensorrtModelDownloadAction = memo(function TensorrtModelDownloadAction({
  model,
  revision,
}: {
  model: CatalogModel
  /** The commit the core's verdict was given for. */
  revision: string
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const token = useGeneralSetting((state) => state.huggingfaceToken) || undefined
  const repository = model.model_name
  const downloadId = tensorrtDownloadId(repository)
  const progress = useDownloadStore((state) => state.downloads[downloadId]?.progress ?? 0)
  const isDownloading = useDownloadStore(
    (state) => state.localDownloadingModels.has(downloadId) || downloadId in state.downloads
  )
  const [failure, setFailure] = useState<Verdict | null>(null)

  const download = useCallback(async () => {
    const store = useDownloadStore.getState()
    setFailure(null)
    store.clearResumableDownload(downloadId)
    // The download panel names the row after this, not after the id.
    store.setDownloadOrigin(downloadId, repository)
    store.addLocalDownloadingModel(downloadId)
    try {
      await installTensorrtModel({ repository, revision, token })
      // The model is a model once `model.yml` is written: list it, so the card turns to "New chat".
      useModelProvider.getState().setProviders(await serviceHub.providers().getProviders())
    } catch (error) {
      // A cancel is the person's own doing, not a failure to report.
      if (!wasDownloadCancellationRequested(downloadId) && !isDownloadCancellationError(error)) {
        setFailure(verdictFromError(error))
      }
    } finally {
      useDownloadStore.getState().removeLocalDownloadingModel(downloadId)
    }
  }, [downloadId, repository, revision, token, serviceHub])

  return (
    <div className="flex flex-col items-end gap-2">
      {isDownloading ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => cancelDownload({ id: downloadId, name: downloadId }, serviceHub)}
          title={t('common:cancelDownload')}
          aria-label={t('common:cancelDownload')}
          className="group relative w-24 justify-center overflow-hidden font-semibold"
        >
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 z-0 bg-primary/20 transition-[width] duration-200"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
          <span className="relative z-1 tabular-nums transition-opacity group-hover:opacity-0">
            {Math.round(progress * 100)}%
          </span>
          <span className="absolute inset-0 z-1 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
            <IconX size={14} />
          </span>
        </Button>
      ) : (
        <Button size="sm" onClick={() => void download()}>
          {t('hub:download')}
        </Button>
      )}
      {failure && <TensorrtVerdict verdict={failure} />}
    </div>
  )
})
