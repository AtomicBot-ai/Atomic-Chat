import { memo, useCallback, useEffect, type KeyboardEvent } from 'react'
import { ChevronRight } from 'lucide-react'
import { IconRestore } from '@tabler/icons-react'
import { useShallow } from 'zustand/shallow'

import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  collapsiblePanelAnimation,
} from '@/components/ui/collapsible'
import { Textarea } from '@/components/ui/textarea'
import { MAX_IMAGE_RUNS, useImageForm } from '@/hooks/useImageForm'
import { useImageGeneration } from '@/hooks/useImageGeneration'
import { useImageSetting } from '@/hooks/useImageSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { DimConstraints } from '@/lib/diffusion/size'
import { cn } from '@/lib/utils'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImageGenerateButton } from './ImageGenerateButton'
import { ImageJobProgress } from './ImageJobProgress'
import { ImageParamSlider } from './ImageParamSlider'
import { ImageSeedField } from './ImageSeedField'
import { ImageSizeControl } from './ImageSizeControl'

/** Until a model reports its ranges: sd.cpp's own limits. */
const FALLBACK_CONSTRAINTS: DimConstraints = {
  minDim: 256,
  maxDim: 2048,
  dimMultiple: 16,
}
const FALLBACK_STEPS: [number, number] = [1, 50]

type ImagePromptFormProps = {
  className?: string
}

/**
 * The left column of the Images page: prompt, size, the advanced knobs, and
 * Generate. Everything reads and writes the persisted form; the model's
 * capabilities decide which controls exist at all (negative prompt, cfg,
 * guidance) — nothing here hardcodes engine behaviour.
 */
export const ImagePromptForm = memo(function ImagePromptForm({
  className,
}: ImagePromptFormProps) {
  const { t } = useTranslation()
  const form = useImageForm(
    useShallow((state) => ({
      prompt: state.prompt,
      negativePrompt: state.negativePrompt,
      negativeOpen: state.negativeOpen,
      width: state.width,
      height: state.height,
      aspect: state.aspect,
      portrait: state.portrait,
      steps: state.steps,
      cfgScale: state.cfgScale,
      guidance: state.guidance,
      seedText: state.seedText,
      batchSize: state.batchSize,
      runs: state.runs,
      patch: state.patch,
      resetToDefaults: state.resetToDefaults,
      clampTo: state.clampTo,
    }))
  )
  const advancedOpen = useImageSetting((state) => state.advancedOpen)
  const setAdvancedOpen = useImageSetting((state) => state.setAdvancedOpen)
  const capabilities = useImageGenerationStore((state) => state.capabilities)
  const generation = useImageGeneration()

  // A model just loaded: fold the draft into what it accepts.
  useEffect(() => {
    if (capabilities) form.clampTo(capabilities)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities])

  const constraints: DimConstraints = capabilities
    ? {
        minDim: capabilities.minDim,
        maxDim: capabilities.maxDim,
        dimMultiple: capabilities.dimMultiple,
      }
    : FALLBACK_CONSTRAINTS
  const [minSteps, maxSteps] = capabilities?.ranges.steps ?? FALLBACK_STEPS
  const maxBatch = Math.max(1, capabilities?.maxBatch ?? 1)
  const showNegative = capabilities?.supportsNegativePrompt ?? false
  // Families distilled to run at cfg 1 have no classifier-free guidance to
  // tune; the slider would be a knob that does nothing.
  const showCfg =
    !capabilities ||
    capabilities.defaults.cfgScale > 1 ||
    capabilities.supportsNegativePrompt
  const showGuidance = capabilities?.supportsGuidance ?? false
  const busy = generation.generating

  const onPromptKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        if (generation.canGenerate) void generation.generate()
      }
    },
    [generation]
  )

  return (
    <form
      className={cn('flex flex-col gap-4', className)}
      onSubmit={(event) => {
        event.preventDefault()
        if (generation.canGenerate) void generation.generate()
      }}
      data-testid="image-prompt-form"
    >
      <div className="space-y-1.5">
        <label htmlFor="image-prompt" className="text-xs font-medium">
          {t('images:form.prompt')}
        </label>
        <Textarea
          id="image-prompt"
          value={form.prompt}
          placeholder={t('images:form.promptPlaceholder')}
          onChange={(event) => form.patch({ prompt: event.target.value })}
          onKeyDown={onPromptKeyDown}
          rows={4}
          className="min-h-24 resize-y"
        />
        <p className="text-[11px] text-muted-foreground">
          {IS_MACOS
            ? t('images:form.shortcutMac')
            : t('images:form.shortcut')}
        </p>
      </div>

      {showNegative && (
        <Collapsible
          open={form.negativeOpen}
          onOpenChange={(open) => form.patch({ negativeOpen: open })}
        >
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronRight
                className={cn(
                  'size-3.5 transition-transform',
                  form.negativeOpen && 'rotate-90'
                )}
              />
              {t('images:form.negativePrompt')}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className={collapsiblePanelAnimation}>
            <Textarea
              id="image-negative-prompt"
              aria-label={t('images:form.negativePrompt')}
              value={form.negativePrompt}
              placeholder={t('images:form.negativePlaceholder')}
              onChange={(event) =>
                form.patch({ negativePrompt: event.target.value })
              }
              onKeyDown={onPromptKeyDown}
              rows={2}
              className="mt-2 min-h-16 resize-y"
            />
          </CollapsibleContent>
        </Collapsible>
      )}

      <ImageSizeControl
        value={{
          width: form.width,
          height: form.height,
          aspect: form.aspect,
          portrait: form.portrait,
        }}
        constraints={constraints}
        disabled={busy}
        onChange={(size) => form.patch(size)}
      />

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <div className="flex items-center justify-between">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              data-testid="image-advanced-toggle"
            >
              <ChevronRight
                className={cn(
                  'size-3.5 transition-transform',
                  advancedOpen && 'rotate-90'
                )}
              />
              {t('images:form.advanced')}
            </button>
          </CollapsibleTrigger>
          {capabilities && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => form.resetToDefaults(capabilities.defaults)}
            >
              <IconRestore size={12} />
              {t('images:form.reset')}
            </Button>
          )}
        </div>
        <CollapsibleContent className={collapsiblePanelAnimation}>
          <div className="mt-3 space-y-4">
            <ImageParamSlider
              id="image-steps"
              label={t('images:form.steps')}
              value={form.steps}
              min={minSteps}
              max={maxSteps}
              step={1}
              disabled={busy}
              onChange={(steps) => form.patch({ steps })}
            />
            {showCfg && (
              <ImageParamSlider
                id="image-cfg"
                label={t('images:form.cfgScale')}
                description={t('images:form.cfgScaleHint')}
                value={form.cfgScale}
                min={1}
                max={20}
                step={0.5}
                disabled={busy}
                onChange={(cfgScale) => form.patch({ cfgScale })}
              />
            )}
            {showGuidance && (
              <ImageParamSlider
                id="image-guidance"
                label={t('images:form.guidance')}
                description={t('images:form.guidanceHint')}
                value={form.guidance ?? capabilities?.defaults.guidance ?? 3.5}
                min={0}
                max={20}
                step={0.5}
                disabled={busy}
                onChange={(guidance) => form.patch({ guidance })}
              />
            )}
            <ImageSeedField
              value={form.seedText}
              disabled={busy}
              onChange={(seedText) => form.patch({ seedText })}
            />
            <div className="grid grid-cols-2 gap-3">
              <ImageParamSlider
                id="image-batch"
                label={t('images:form.batchSize')}
                value={form.batchSize}
                min={1}
                max={maxBatch}
                step={1}
                disabled={busy || maxBatch === 1}
                onChange={(batchSize) => form.patch({ batchSize })}
              />
              <ImageParamSlider
                id="image-runs"
                label={t('images:form.runs')}
                value={form.runs}
                min={1}
                max={MAX_IMAGE_RUNS}
                step={1}
                disabled={busy}
                onChange={(runs) => form.patch({ runs })}
              />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <div className="space-y-2">
        <ImageGenerateButton
          generating={generation.generating}
          stopRequested={generation.stopRequested}
          disabledReason={generation.disabledReason}
          imageCount={form.batchSize * form.runs}
          onGenerate={() => void generation.generate()}
          onStop={() => void generation.stop()}
        />
        {generation.generating && (
          <ImageJobProgress
            job={generation.job}
            runsTotal={generation.runsTotal}
            runsDone={generation.runsDone}
            stopping={generation.stopRequested}
          />
        )}
      </div>
    </form>
  )
})

export default ImagePromptForm
