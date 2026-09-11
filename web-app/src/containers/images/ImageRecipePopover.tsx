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
import { captureImageGalleryAction } from '@/lib/diffusion/telemetry'
import type { ImageRecipe } from '@/services/diffusion/types'

type ImageRecipePopoverProps = {
  recipe: ImageRecipe
  /** The recipe's model is not the selected one; Restore will switch to it. */
  modelDiffers: boolean
  onRestore: () => void
}

/**
 * The embedded recipe, readable, with "Restore these settings".
 *
 * Every row is a value the user chose or the engine recorded; the prompt is
 * copyable on its own because that is the part people reuse most.
 */
export const ImageRecipePopover = memo(function ImageRecipePopover({
  recipe,
  modelDiffers,
  onRestore,
}: ImageRecipePopoverProps) {
  const { t } = useTranslation()

  const rows: Array<[string, string]> = [
    [t('images:viewer.details.model'), recipe.model.displayName],
    [t('images:viewer.details.size'), `${recipe.width}×${recipe.height}`],
    [t('images:viewer.details.steps'), String(recipe.steps)],
    [t('images:viewer.details.cfg'), String(recipe.cfgScale)],
  ]
  if (recipe.guidance !== null) {
    rows.push([t('images:viewer.details.guidance'), String(recipe.guidance)])
  }
  rows.push([t('images:viewer.details.seed'), String(recipe.seed)])
  if (recipe.batchSize > 1) {
    rows.push([
      t('images:viewer.details.batchSeed'),
      `${recipe.batchSeed} · ${recipe.index + 1}/${recipe.batchSize}`,
    ])
  }
  if (recipe.samplingMethod) {
    rows.push([t('images:viewer.details.sampler'), recipe.samplingMethod])
  }
  rows.push([
    t('images:viewer.details.engine'),
    `${recipe.engine.kind} · ${recipe.engine.backend}${
      recipe.engine.cpuFallback ? ' (cpu)' : ''
    }`,
  ])
  rows.push([
    t('images:viewer.details.duration'),
    t('images:viewer.details.seconds', {
      seconds: (recipe.durationMs / 1000).toFixed(1),
    }),
  ])

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(recipe.prompt)
      captureImageGalleryAction('copy_prompt')
      toast.success(t('images:viewer.promptCopied'))
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
          aria-label={t('images:viewer.recipe')}
          data-testid="image-recipe-trigger"
        >
          <IconInfoCircle size={16} />
          {t('images:viewer.recipe')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-3 p-3">
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">
              {t('images:form.prompt')}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('images:viewer.copyPrompt')}
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
                {t('images:form.negativePrompt')}
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
          data-testid="image-recipe-restore"
        >
          <IconRestore size={16} />
          {modelDiffers
            ? t('images:viewer.restoreAndLoad')
            : t('images:viewer.restore')}
        </Button>
      </PopoverContent>
    </Popover>
  )
})

export default ImageRecipePopover
