import { memo } from 'react'
import { IconDownload, IconMovie, IconPhoto } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { DiffusionModality } from '@/services/diffusion/types'

type ImageEmptyStateProps = {
  /** With no model resident the next step is picking one, not writing a prompt. */
  modelLoaded?: boolean
  /** Set while no checkpoint is on disk: opens the form's model picker. */
  onDownloadModel?: () => void
  /** The Video page shows the same state with its own words and mark. */
  modality?: DiffusionModality
}

/**
 * The canvas before the first image: what this page does, and — until a model
 * is on disk — the one click that gets one.
 */
export const ImageEmptyState = memo(function ImageEmptyState({
  modelLoaded = true,
  onDownloadModel,
  modality = 'image',
}: ImageEmptyStateProps) {
  const { t } = useTranslation()
  const ns = modality === 'video' ? 'videos' : 'images'
  const Icon = modality === 'video' ? IconMovie : IconPhoto
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
            modelLoaded
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
