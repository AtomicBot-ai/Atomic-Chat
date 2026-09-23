import { memo } from 'react'
import { IconCopy, IconInfoCircle, IconRestore } from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { captureVideoGalleryAction } from '@/lib/diffusion/telemetry'
import { formatSeconds, secondsForFrames } from '@/lib/video/duration'
import type { VideoRecipe } from '@/services/diffusion/types'

type VideoRecipePopoverProps = {
  recipe: VideoRecipe
  /** The recipe's model is not the selected one; Restore will switch to it. */
  modelDiffers: boolean
  onRestore: () => void
}

/**
 * The clip's recipe, readable, with "Restore these settings". The frame
 * count shown is the one the engine wrote, at the family's rate; the
 * requested count is what Restore puts back in the form.
 */
export const VideoRecipePopover = memo(function VideoRecipePopover({
  recipe,
  modelDiffers,
  onRestore,
}: VideoRecipePopoverProps) {
  const { t } = useTranslation()

  const rows: Array<[string, string]> = [
    [t('videos:viewer.details.model'), recipe.model.displayName],
    [t('videos:viewer.details.size'), `${recipe.width}×${recipe.height}`],
    [
      t('videos:viewer.details.frames'),
      t('videos:viewer.details.framesValue', {
        frames: recipe.frameCount,
        fps: recipe.fps,
      }),
    ],
    [
      t('videos:viewer.details.duration'),
      t('videos:viewer.details.seconds', {
        seconds: formatSeconds(secondsForFrames(recipe.frameCount, recipe.fps)),
      }),
    ],
    [t('videos:viewer.details.steps'), String(recipe.steps)],
    [t('videos:viewer.details.cfg'), String(recipe.cfgScale)],
  ]
  if (recipe.guidance !== null) {
    rows.push([t('videos:viewer.details.guidance'), String(recipe.guidance)])
  }
  rows.push([t('videos:viewer.details.seed'), String(recipe.seed)])
  if (recipe.samplingMethod) {
    rows.push([t('videos:viewer.details.sampler'), recipe.samplingMethod])
  }
  rows.push([
    t('videos:viewer.details.engine'),
    `${recipe.engine.kind} · ${recipe.engine.backend}${
      recipe.engine.cpuFallback ? ' (cpu)' : ''
    }`,
  ])
  rows.push([
    t('videos:viewer.details.took'),
    t('videos:viewer.details.seconds', {
      seconds: (recipe.durationMs / 1000).toFixed(1),
    }),
  ])

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(recipe.prompt)
      captureVideoGalleryAction('copy_prompt')
      toast.success(t('videos:viewer.promptCopied'))
    } catch {
      // Clipboard access can be refused; the prompt is still on screen.
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('videos:viewer.recipe')}
          data-testid="video-recipe-trigger"
        >
          <IconInfoCircle size={16} />
          <span>{t('videos:viewer.recipe')}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-3 p-3">
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">
              {t('videos:form.prompt')}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('videos:viewer.copyPrompt')}
              onClick={() => void copyPrompt()}
            >
              <IconCopy size={14} />
            </Button>
          </div>
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {recipe.prompt}
          </p>
          {recipe.negativePrompt && (
            <>
              <span className="text-xs font-medium">
                {t('videos:form.negativePrompt')}
              </span>
              <p className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                {recipe.negativePrompt}
              </p>
            </>
          )}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="truncate font-mono tabular-nums" title={value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <Button
          size="sm"
          className="w-full"
          onClick={onRestore}
          data-testid="video-recipe-restore"
        >
          <IconRestore size={16} />
          {modelDiffers
            ? t('videos:viewer.restoreAndLoad')
            : t('videos:viewer.restore')}
        </Button>
      </PopoverContent>
    </Popover>
  )
})

export default VideoRecipePopover
