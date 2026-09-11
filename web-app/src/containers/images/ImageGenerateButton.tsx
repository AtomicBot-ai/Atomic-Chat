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

  if (generating) {
    return (
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={stopRequested}
        onClick={onStop}
        data-testid="image-stop"
      >
        {stopRequested ? (
          <IconLoader2 size={16} className="animate-spin" />
        ) : (
          <IconPlayerStopFilled size={16} />
        )}
        {stopRequested ? t('images:form.stopping') : t('images:form.stop')}
      </Button>
    )
  }

  const button = (
    <Button
      type="button"
      className="w-full"
      disabled={disabledReason !== null}
      onClick={onGenerate}
      data-testid="image-generate"
    >
      <IconSparkles size={16} />
      {imageCount > 1
        ? t('images:form.generateCount', { count: imageCount })
        : t('images:form.generate')}
    </Button>
  )

  if (!disabledReason) return button

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex w-full">{button}</span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{t(`images:form.disabled.${disabledReason}`)}</p>
      </TooltipContent>
    </Tooltip>
  )
})

export default ImageGenerateButton
