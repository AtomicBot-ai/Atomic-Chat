import { memo } from 'react'
import { IconSparkles } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'

const SAMPLE_KEYS = [
  'images:gallery.samples.one',
  'images:gallery.samples.two',
  'images:gallery.samples.three',
] as const

type ImageEmptyStateProps = {
  /** Put a sample prompt into the form. */
  onPickPrompt: (prompt: string) => void
}

/**
 * The gallery before the first image: what this page does, and three prompts
 * to start from so the first click is one tap away rather than a blank box.
 */
export const ImageEmptyState = memo(function ImageEmptyState({
  onPickPrompt,
}: ImageEmptyStateProps) {
  const { t } = useTranslation()
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center"
      data-testid="image-empty-state"
    >
      <div className="grid size-12 place-items-center rounded-xl bg-secondary">
        <IconSparkles size={24} className="text-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-base font-medium">{t('images:gallery.empty.title')}</p>
        <p className="max-w-md text-sm text-muted-foreground">
          {t('images:gallery.empty.description')}
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {SAMPLE_KEYS.map((key) => {
          const prompt = t(key)
          return (
            <Button
              key={key}
              variant="outline"
              size="sm"
              className="max-w-xs whitespace-normal text-left"
              onClick={() => onPickPrompt(prompt)}
            >
              {prompt}
            </Button>
          )
        })}
      </div>
    </div>
  )
})

export default ImageEmptyState
