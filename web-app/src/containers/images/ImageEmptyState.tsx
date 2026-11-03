import { memo } from 'react'
import {
  IconDownload,
  IconMovie,
  IconPhoto,
  IconWaveSine,
} from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { DiffusionModality } from '@/services/diffusion/types'

type ImageEmptyStateProps = {
  /**
   * With no model to run the next step is picking one, not writing a prompt.
   * A picked model that is stopped counts: Generate starts it.
   */
  modelPicked?: boolean
  /** Set while no checkpoint is on disk: opens the form's model picker. */
  onDownloadModel?: () => void
  /** The Video and Audio pages show the same state with their own words and mark. */
  modality?: DiffusionModality | 'audio'
}

const NAMESPACE = { image: 'images', video: 'videos', audio: 'audios' }
const ICON = { image: IconPhoto, video: IconMovie, audio: IconWaveSine }

/**
 * The canvas before the first image: what this page does, and — until a model
 * is on disk — the one click that gets one.
 */
export const ImageEmptyState = memo(function ImageEmptyState({
  modelPicked = true,
  onDownloadModel,
  modality = 'image',
}: ImageEmptyStateProps) {
  const { t } = useTranslation()
  const ns = NAMESPACE[modality]
  const Icon = ICON[modality]
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-5 px-10 py-8 text-center"
      data-testid="image-empty-state"
      data-modality={modality}
    >
      <div className="grid size-16 place-items-center rounded-2xl bg-secondary text-muted-foreground">
        <Icon size={30} stroke={1.5} />
      </div>
      <div className="space-y-1.5">
        <p className="font-studio text-lg font-medium">
          {t(`${ns}:gallery.empty.title`)}
        </p>
        <p className="max-w-md text-sm leading-snug text-muted-foreground">
          {t(
            modelPicked
              ? `${ns}:gallery.empty.description`
              : `${ns}:gallery.emptyNoModel`
          )}
        </p>
      </div>
      {onDownloadModel && (
        <Button onClick={onDownloadModel} data-testid="image-empty-download">
          <IconDownload size={16} />
          {t(`${ns}:setup.card.downloadModel`)}
        </Button>
      )}
    </div>
  )
})

export default ImageEmptyState
