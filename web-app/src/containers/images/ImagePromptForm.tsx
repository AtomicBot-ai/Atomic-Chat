import {
  memo,
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  IconChevronDown,
  IconChevronRight,
  IconRestore,
  IconSettings,
} from '@tabler/icons-react'
import { useShallow } from 'zustand/shallow'

import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  collapsiblePanelAnimation,
} from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { route } from '@/constants/routes'
import {
  MAX_IMAGE_BATCH,
  MAX_IMAGE_RUNS,
  useImageForm,
} from '@/hooks/useImageForm'
import { useImageGeneration } from '@/hooks/useImageGeneration'
import { useImageEngine } from '@/hooks/useImageEngine'
import {
  IMAGE_IDLE_UNLOAD_OPTIONS,
  IMAGE_OFFLOAD_OVERRIDES,
  useImageSetting,
  type ImageEngineOverride,
  type ImageEvictPolicy,
  type ImageOffloadOverride,
} from '@/hooks/useImageSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { DimConstraints } from '@/lib/diffusion/size'
import { workflowSpec } from '@/lib/diffusion/workflows'
import { cn } from '@/lib/utils'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImageField, ImageFieldHint } from './ImageField'
import { ImageApiSettingsCard } from './ImageApiSettingsCard'
import { ImageWorkflowInputs } from './ImageWorkflowInputs'
import { WORKFLOW_ICONS } from './workflowIcons'
import { ImageGenerateButton } from './ImageGenerateButton'
import { ImageModelPicker } from './ImageModelPicker'
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
  modelsOpen?: boolean
  onModelsOpenChange?: (open: boolean) => void
}

/**
 * The left column of the Images page: a heading, the prompt, size, the
 * sampling knobs as one-line sliders, the seed, an Advanced fold for the
 * load-time options, and Generate pinned under the scrolling settings.
 *
 * Everything reads and writes the persisted form; the model's capabilities
 * decide which controls exist at all (negative prompt, cfg, guidance) —
 * nothing here hardcodes engine behaviour.
 */
export const ImagePromptForm = memo(function ImagePromptForm({
  className,
  modelsOpen: controlledModelsOpen,
  onModelsOpenChange,
}: ImagePromptFormProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
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
      workflow: state.workflow,
      patch: state.patch,
      resetToDefaults: state.resetToDefaults,
      clampTo: state.clampTo,
    }))
  )
  const {
    advancedOpen,
    setAdvancedOpen,
    keepModelLoaded,
    setKeepModelLoaded,
    idleUnloadMinutes,
    setIdleUnloadMinutes,
    offloadOverride,
    setOffloadOverride,
    engineOverride,
    setEngineOverride,
    evictChatModel,
    setEvictChatModel,
  } = useImageSetting(
    useShallow((state) => ({
      advancedOpen: state.advancedOpen,
      setAdvancedOpen: state.setAdvancedOpen,
      keepModelLoaded: state.keepModelLoaded,
      setKeepModelLoaded: state.setKeepModelLoaded,
      idleUnloadMinutes: state.idleUnloadMinutes,
      setIdleUnloadMinutes: state.setIdleUnloadMinutes,
      offloadOverride: state.offloadOverride,
      setOffloadOverride: state.setOffloadOverride,
      engineOverride: state.engineOverride,
      setEngineOverride: state.setEngineOverride,
      evictChatModel: state.evictChatModel,
      setEvictChatModel: state.setEvictChatModel,
    }))
  )
  const engine = useImageEngine()
  const capabilities = useImageGenerationStore((state) => state.capabilities)
  const applyIdleSettings = useImageGenerationStore(
    (state) => state.applyIdleSettings
  )
  const generation = useImageGeneration()
  const [internalModelsOpen, setInternalModelsOpen] = useState(false)
  const modelsOpen = controlledModelsOpen ?? internalModelsOpen
  const setModelsOpen = onModelsOpenChange ?? setInternalModelsOpen

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
  const maxBatch = Math.max(1, capabilities?.maxBatch ?? MAX_IMAGE_BATCH)
  const showNegative = capabilities?.supportsNegativePrompt ?? false
  // Families distilled to run at cfg 1 have no classifier-free guidance to
  // tune; the slider would be a knob that does nothing.
  const showCfg =
    !capabilities ||
    capabilities.defaults.cfgScale > 1 ||
    capabilities.supportsNegativePrompt
  const showGuidance = capabilities?.supportsGuidance ?? false
  const busy = generation.generating
  const spec = workflowSpec(form.workflow)
  const WorkflowIcon = WORKFLOW_ICONS[form.workflow]
  const isEdit = form.workflow === 'edit'
  const idleLabel = (minutes: number) =>
    minutes === 0
      ? t('settings:media.idleNever')
      : t('settings:media.idleMinutes', { minutes })
  const memoryLabel = (value: ImageOffloadOverride) =>
    t(
      value === 'auto'
        ? 'images:form.memoryAuto'
        : value === 'none'
          ? 'images:form.memoryNone'
          : value === 'group'
            ? 'images:form.memoryGroup'
            : 'images:form.memoryModel'
    )
  const engineLabel = (value: ImageEngineOverride) =>
    value === 'auto'
      ? t('settings:media.engineAuto')
      : value === 'sd-cpp'
        ? 'stable-diffusion.cpp'
        : 'diffusers'
  const evictLabel = (value: ImageEvictPolicy) =>
    value === 'always'
      ? t('settings:media.evictAlways')
      : t('settings:media.evictWhenNeeded')

  const setKeep = (value: boolean) => {
    setKeepModelLoaded(value)
    void applyIdleSettings()
  }

  const setIdle = (minutes: number) => {
    setIdleUnloadMinutes(minutes)
    void applyIdleSettings()
  }

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
      className={cn('flex min-h-0 flex-1 flex-col', className)}
      onSubmit={(event) => {
        event.preventDefault()
        if (generation.canGenerate) void generation.generate()
      }}
      data-testid="image-prompt-form"
    >
      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pt-4 pb-4 [scrollbar-gutter:stable]"
        data-testid="image-form-scroller"
      >
        {/* The sidebar names the section; this names what the column does. */}
        <div className="mb-1 flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2
              className="flex items-center gap-2 font-studio text-xl font-medium leading-none"
              data-testid="image-workflow-title"
            >
              <WorkflowIcon size={18} className="shrink-0" />
              {t(`images:workflow.${form.workflow}.title`)}
            </h2>
            <p className="text-xs leading-snug text-muted-foreground">
              {t(`images:workflow.${form.workflow}.hint`)}
            </p>
          </div>
          {capabilities && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  disabled={busy}
                  aria-label={t('images:form.reset')}
                  onClick={() => form.resetToDefaults(capabilities.defaults)}
                >
                  <IconRestore size={16} />
                  <span className="sr-only">{t('images:form.reset')}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('images:form.resetHint')}</TooltipContent>
            </Tooltip>
          )}
        </div>

        <ImageWorkflowInputs
          workflow={form.workflow}
          constraints={constraints}
          outputSize={generation.outputSize}
          disabled={busy}
        />

        <div
          className="space-y-2.5 rounded-2xl border bg-secondary/20 p-2.5"
          data-testid="image-prompt-card"
        >
          <ImageModelPicker open={modelsOpen} onOpenChange={setModelsOpen} />
          <ImageField
            htmlFor="image-prompt"
            label={t(isEdit ? 'images:form.instruction' : 'images:form.prompt')}
          >
            <Textarea
              id="image-prompt"
              value={form.prompt}
              placeholder={t(
                isEdit
                  ? 'images:form.instructionPlaceholder'
                  : 'images:form.promptPlaceholder'
              )}
              onChange={(event) => form.patch({ prompt: event.target.value })}
              onKeyDown={onPromptKeyDown}
              rows={3}
              className="min-h-20 resize-none rounded-xl bg-background px-3.5 py-2.5"
            />
          </ImageField>
          <ImageGenerateButton
            generating={generation.generating}
            stopRequested={generation.stopRequested}
            disabledReason={generation.disabledReason}
            imageCount={form.batchSize * form.runs}
            onGenerate={() => void generation.generate()}
            onStop={() => void generation.stop()}
          />
        </div>

        {showNegative && (
          <Collapsible
            open={form.negativeOpen}
            onOpenChange={(open) => form.patch({ negativeOpen: open })}
            className="flex flex-col gap-1.5"
          >
            <div className="flex items-center gap-1">
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  {t('images:form.negativePrompt')}
                  <IconChevronDown
                    size={14}
                    className={cn(
                      'transition-transform',
                      form.negativeOpen && 'rotate-180'
                    )}
                  />
                </button>
              </CollapsibleTrigger>
              <ImageFieldHint>{t('images:form.negativeHint')}</ImageFieldHint>
            </div>
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
                className="min-h-16 resize-none rounded-2xl px-4 py-3"
              />
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Inpaint, extend, upscale and edit take their size from the
            source; a size control there would be a knob that does nothing. */}
        {spec.usesResolution && (
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
        )}

        {/* The one-line sliders, a touch apart from the fields above. */}
        <div className="flex flex-col gap-3.5 pt-1">
          <ImageParamSlider
            id="image-steps"
            label={t('images:form.steps')}
            description={t('images:form.stepsHint')}
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
          <ImageParamSlider
            id="image-batch"
            label={t('images:form.batchSize')}
            description={t('images:form.batchSizeHint')}
            value={form.batchSize}
            min={1}
            max={maxBatch}
            step={1}
            disabled={busy || (capabilities !== null && maxBatch === 1)}
            onChange={(batchSize) => form.patch({ batchSize })}
          />
          <ImageParamSlider
            id="image-runs"
            label={t('images:form.runs')}
            description={t('images:form.runsHint')}
            value={form.runs}
            min={1}
            max={MAX_IMAGE_RUNS}
            step={1}
            disabled={busy}
            onChange={(runs) => form.patch({ runs })}
          />
        </div>

        <ImageSeedField
          value={form.seedText}
          disabled={busy}
          onChange={(seedText) => form.patch({ seedText })}
        />

        <Collapsible
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
          className="mt-1 border-t border-border/60 pt-3"
        >
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-secondary/60"
              data-testid="image-advanced-toggle"
            >
              <span className="min-w-0 flex-1 text-xs font-medium">
                {t('images:form.advanced')}
              </span>
              <IconChevronDown
                size={16}
                className={cn(
                  'shrink-0 text-muted-foreground transition-transform',
                  advancedOpen && 'rotate-180'
                )}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent
            className={cn(
              collapsiblePanelAnimation,
              'duration-250 ease-out will-change-[height] motion-reduce:animate-none motion-reduce:duration-0'
            )}
            data-testid="image-advanced-panel"
          >
            <div className="flex flex-col gap-3 pt-3">
              <AdvancedSelect
                label={t('images:form.memory')}
                hint={t('images:form.memoryHint')}
                value={offloadOverride}
                options={IMAGE_OFFLOAD_OVERRIDES.map((value) => [
                  value,
                  memoryLabel(value),
                ])}
                onChange={setOffloadOverride}
              />
              {engine.engineChoices.length > 1 && (
                <AdvancedSelect
                  label={t('settings:media.engineOverride')}
                  hint={t('images:form.engineHint')}
                  value={engineOverride}
                  options={(
                    ['auto', ...engine.engineChoices] as ImageEngineOverride[]
                  ).map((value) => [value, engineLabel(value)])}
                  onChange={setEngineOverride}
                />
              )}
              <AdvancedSelect
                label={t('images:form.evictChat')}
                hint={t('settings:media.evictChatDescription')}
                value={evictChatModel}
                options={(['whenNeeded', 'always'] as ImageEvictPolicy[]).map(
                  (value) => [value, evictLabel(value)]
                )}
                onChange={setEvictChatModel}
              />
              <AdvancedSelect
                label={t('settings:media.idleUnload')}
                hint={t('settings:media.idleUnloadDescription')}
                value={idleUnloadMinutes}
                disabled={keepModelLoaded}
                options={IMAGE_IDLE_UNLOAD_OPTIONS.map((minutes) => [
                  minutes,
                  idleLabel(minutes),
                ])}
                onChange={setIdle}
              />
              <div className="flex h-8 items-center justify-between gap-3">
                <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  {t('settings:media.keepLoaded')}
                  <ImageFieldHint>
                    {t('settings:media.keepLoadedDescription')}
                  </ImageFieldHint>
                </span>
                <Switch
                  checked={keepModelLoaded}
                  onCheckedChange={setKeep}
                  aria-label={t('settings:media.keepLoaded')}
                />
              </div>
              <ImageApiSettingsCard variant="embedded" />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full justify-between rounded-full"
                onClick={() => void navigate({ to: route.settings.media })}
              >
                <span className="flex items-center gap-2">
                  <IconSettings size={14} className="text-muted-foreground" />
                  {t('images:form.mediaSettings')}
                </span>
                <IconChevronRight size={14} />
              </Button>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </form>
  )
})

type AdvancedSelectProps<T extends string | number> = {
  label: string
  hint?: ReactNode
  value: T
  options: Array<[T, string]>
  disabled?: boolean
  onChange: (value: T) => void
}

/** One Advanced row: a muted label on the left, a pill menu on the right. */
function AdvancedSelect<T extends string | number>({
  label,
  hint,
  value,
  options,
  disabled,
  onChange,
}: AdvancedSelectProps<T>) {
  const current =
    options.find(([option]) => option === value)?.[1] ?? String(value)
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-1 text-xs font-medium text-muted-foreground">
        <span className="truncate">{label}</span>
        {hint && <ImageFieldHint>{hint}</ImageFieldHint>}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-40 shrink-0 justify-between text-xs font-normal"
            disabled={disabled}
            aria-label={label}
          >
            <span className="truncate">{current}</span>
            <IconChevronDown
              size={16}
              className="shrink-0 text-muted-foreground"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          {options.map(([option, text]) => (
            <DropdownMenuItem
              key={String(option)}
              className={cn(
                'cursor-pointer text-xs',
                option === value && 'bg-secondary-foreground/8'
              )}
              onClick={() => onChange(option)}
            >
              {text}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export default ImagePromptForm
