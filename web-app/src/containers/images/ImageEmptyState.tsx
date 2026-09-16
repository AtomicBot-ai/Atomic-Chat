import { memo } from 'react'
import { IconPhoto } from '@tabler/icons-react'

import { useTranslation } from '@/i18n/react-i18next-compat'

type ImageEmptyStateProps = {
  /** With no model resident the next step is picking one, not writing a prompt. */
  modelLoaded?: boolean
}

/** The canvas before the first image: what this page does, nothing to click. */
export const ImageEmptyState = memo(function ImageEmptyState({
  modelLoaded = true,
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
    </div>
  )
})

export default ImageEmptyState
