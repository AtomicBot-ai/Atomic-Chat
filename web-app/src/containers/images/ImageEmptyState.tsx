import { memo } from 'react'
import { IconDownload, IconPhoto } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'

type ImageEmptyStateProps = {
  /** With no model resident the next step is picking one, not writing a prompt. */
  modelLoaded?: boolean
  /** Set while no checkpoint is on disk: opens the form's model picker. */
  onDownloadModel?: () => void
}

/**
 * The canvas before the first image: what this page does, and — until a model
 * is on disk — the one click that gets one.
 */
export const ImageEmptyState = memo(function ImageEmptyState({
  modelLoaded = true,
  onDownloadModel,
}: ImageEmptyStateProps) {
  const { t } = useTranslation()
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-5 px-10 py-8 text-center"
      data-testid="image-empty-state"
    >
      <div className="grid size-16 place-items-center rounded-2xl bg-secondary text-muted-foreground">
        <IconPhoto size={30} stroke={1.5} />
      </div>
      <div className="space-y-1.5">
        <p className="font-studio text-lg font-medium">
          {t('images:gallery.empty.title')}
        </p>
        <p className="max-w-md text-sm leading-snug text-muted-foreground">
          {t(
            modelLoaded
              ? 'images:gallery.empty.description'
              : 'images:gallery.emptyNoModel'
          )}
        </p>
      </div>
      {onDownloadModel && (
        <Button onClick={onDownloadModel} data-testid="image-empty-download">
          <IconDownload size={16} />
          {t('images:setup.card.downloadModel')}
        </Button>
      )}
    </div>
  )
})

export default ImageEmptyState
