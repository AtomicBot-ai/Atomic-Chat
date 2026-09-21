import { memo } from 'react'
import { IconLoader2, IconPlayerStopFilled, IconSparkles } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { GenerateDisabledReason } from '@/hooks/useImageGeneration'

type ImageGenerateButtonProps = {
  generating: boolean
  stopRequested: boolean
  disabledReason: GenerateDisabledReason | null
  /** Total images this click produces: batch × runs. */
  imageCount: number
  onGenerate: () => void
  onStop: () => void
}

/**
 * Generate ⇄ Stop.
 *
 * While generating the button becomes Stop, so the user never has to find a
 * second control. Disabled Generate carries its reason in a tooltip — the
 * wrapper is the trigger, because a disabled button fires no pointer events.
 */
export const ImageGenerateButton = memo(function ImageGenerateButton({
  generating,
  stopRequested,
  disabledReason,
  imageCount,
  onGenerate,
  onStop,
}: ImageGenerateButtonProps) {
  const { t } = useTranslation()
  const disabled = generating ? stopRequested : disabledReason !== null

  const button = (
    <Button
      type="button"
      variant={generating ? 'outline' : 'default'}
      size="default"
      className="h-9 w-full px-6 transition-transform duration-150 ease-out active:scale-[0.985] disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
      disabled={disabled}
      onClick={generating ? onStop : onGenerate}
      data-testid={generating ? 'image-stop' : 'image-generate'}
    >
      {generating ? (
        stopRequested ? (
          <IconLoader2 size={16} className="animate-spin" />
        ) : (
          <IconPlayerStopFilled size={16} />
        )
      ) : (
        <IconSparkles size={16} />
      )}
      {generating
        ? stopRequested
          ? t('images:form.stopping')
          : t('images:form.stop')
        : imageCount > 1
          ? t('images:form.generateCount', { count: imageCount })
          : t('images:form.generate')}
    </Button>
  )

  return (
    <div className="h-9 w-full" data-testid="image-generate-slot">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="block h-full w-full">{button}</span>
        </TooltipTrigger>
        {!generating && disabledReason && (
          <TooltipContent>
            <p>{t(`images:form.disabled.${disabledReason}`)}</p>
          </TooltipContent>
        )}
      </Tooltip>
    </div>
  )
})

export default ImageGenerateButton
