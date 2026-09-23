import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  IconChevronDown,
  IconChevronRight,
  IconMovie,
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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { route } from '@/constants/routes'
import { ImageApiSettingsCard } from '@/containers/images/ImageApiSettingsCard'
import { ImageField, ImageFieldHint } from '@/containers/images/ImageField'
import { ImageGenerateButton } from '@/containers/images/ImageGenerateButton'
import { ImageModelPicker } from '@/containers/images/ImageModelPicker'
import { ImageParamSlider } from '@/containers/images/ImageParamSlider'
import { AdvancedSelect } from '@/containers/images/ImagePromptForm'
import { ImageSeedField } from '@/containers/images/ImageSeedField'
import { useImageEngine } from '@/hooks/useImageEngine'
import {
  IMAGE_IDLE_UNLOAD_OPTIONS,
  IMAGE_OFFLOAD_OVERRIDES,
  useImageSetting,
  type ImageEngineOverride,
  type ImageEvictPolicy,
  type ImageOffloadOverride,
} from '@/hooks/useImageSetting'
import { useVideoForm } from '@/hooks/useVideoForm'
import { useVideoGeneration } from '@/hooks/useVideoGeneration'
import { useVideoSetting } from '@/hooks/useVideoSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { durationOptions } from '@/lib/video/duration'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { VideoDurationSelect } from './VideoDurationSelect'
import { VideoResolutionSelect } from './VideoResolutionSelect'

/** Until a model reports its presets: LTX's landscape default. */
const FALLBACK_PRESETS: readonly [number, number][] = [[768, 512]]
const FALLBACK_STEPS: [number, number] = [1, 50]
const FALLBACK_LATTICE = { fps: 24, min: 9, max: 257, step: 8, offset: 1 }

type VideoPromptFormProps = {
  className?: string
  modelsOpen?: boolean
  onModelsOpenChange?: (open: boolean) => void
}

/**
 * The left column of the Video page: the same column as Images with the
 * video knobs — a resolution preset, a duration, the fixed frame rate, steps,
 * guidance, the seed — and the same Advanced fold. The load-time options
 * (memory, engine, evicting chat, idle unload) are the Images settings: one
 * engine, one resident model, so one set of rules.
 */
export const VideoPromptForm = memo(function VideoPromptForm({
  className,
  modelsOpen: controlledModelsOpen,
  onModelsOpenChange,
}: VideoPromptFormProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const form = useVideoForm(
    useShallow((state) => ({
      prompt: state.prompt,
      negativePrompt: state.negativePrompt,
      negativeOpen: state.negativeOpen,
      width: state.width,
      height: state.height,
      frames: state.frames,
      steps: state.steps,
      cfgScale: state.cfgScale,
      guidance: state.guidance,
      seedText: state.seedText,
      patch: state.patch,
      resetToDefaults: state.resetToDefaults,
      clampTo: state.clampTo,
    }))
  )
  const { advancedOpen, setAdvancedOpen } = useVideoSetting(
    useShallow((state) => ({
      advancedOpen: state.advancedOpen,
      setAdvancedOpen: state.setAdvancedOpen,
    }))
  )
  const {
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
  const capabilities = useImageGenerationStore(
    (state) => state.videoCapabilities
  )
  const applyIdleSettings = useImageGenerationStore(
    (state) => state.applyIdleSettings
  )
  const generation = useVideoGeneration()
  const [internalModelsOpen, setInternalModelsOpen] = useState(false)
  const modelsOpen = controlledModelsOpen ?? internalModelsOpen
  const setModelsOpen = onModelsOpenChange ?? setInternalModelsOpen

  // A model just loaded: fold the draft into what it accepts.
  useEffect(() => {
    if (capabilities) form.clampTo(capabilities)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities])

  const presets = capabilities?.resolutionPresets ?? FALLBACK_PRESETS
  const lattice = capabilities
    ? { fps: capabilities.fps, ...capabilities.frames }
    : FALLBACK_LATTICE
  const durations = useMemo(
    () =>
      durationOptions(lattice, undefined, [
        ...(capabilities ? [capabilities.frames.default] : []),
        form.frames,
      ]),
    // The lattice is derived from the capabilities object, which is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [capabilities, form.frames]
  )
  const [minSteps, maxSteps] = capabilities?.ranges.steps ?? FALLBACK_STEPS
  const showNegative = capabilities?.supportsNegativePrompt ?? false
  // A family distilled to run at cfg 1 has no classifier-free guidance to
  // tune (LTX); Wan runs at cfg 5 with a negative prompt, so it gets the knob.
  const showGuidance =
    !capabilities ||
    capabilities.defaults.cfgScale > 1 ||
    capabilities.supportsNegativePrompt
  const showDistilledGuidance = capabilities?.supportsGuidance ?? false
  const busy = generation.generating
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
      data-testid="video-prompt-form"
    >
      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pt-4 pb-4 [scrollbar-gutter:stable]"
        data-testid="video-form-scroller"
      >
        <div className="mb-1 flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2
              className="flex items-center gap-2 font-studio text-xl font-medium leading-none"
              data-testid="video-form-title"
            >
              <IconMovie size={18} className="shrink-0" />
              {t('videos:form.title')}
            </h2>
            <p className="text-xs leading-snug text-muted-foreground">
              {t('videos:form.hint')}
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
                  aria-label={t('videos:form.reset')}
                  onClick={() => form.resetToDefaults(capabilities)}
                >
                  <IconRestore size={16} />
                  <span className="sr-only">{t('videos:form.reset')}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('videos:form.resetHint')}</TooltipContent>
            </Tooltip>
          )}
        </div>

        <div
          className="space-y-2.5 rounded-2xl border bg-secondary/20 p-2.5"
          data-testid="video-prompt-card"
        >
          <ImageModelPicker
            open={modelsOpen}
            onOpenChange={setModelsOpen}
            modality="video"
          />
          <ImageField htmlFor="video-prompt" label={t('videos:form.prompt')}>
            <Textarea
              id="video-prompt"
              value={form.prompt}
              placeholder={t('videos:form.promptPlaceholder')}
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
            imageCount={1}
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
                  {t('videos:form.negativePrompt')}
                  <IconChevronDown
                    size={14}
                    className={cn(
                      'transition-transform',
                      form.negativeOpen && 'rotate-180'
                    )}
                  />
                </button>
              </CollapsibleTrigger>
              <ImageFieldHint>{t('videos:form.negativeHint')}</ImageFieldHint>
            </div>
            <CollapsibleContent className={collapsiblePanelAnimation}>
              <Textarea
                id="video-negative-prompt"
                aria-label={t('videos:form.negativePrompt')}
                value={form.negativePrompt}
                placeholder={t('videos:form.negativePlaceholder')}
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

        <VideoResolutionSelect
          width={form.width}
          height={form.height}
          presets={presets}
          disabled={busy}
          onChange={(size) => form.patch(size)}
        />

        <VideoDurationSelect
          frames={form.frames}
          options={durations}
          disabled={busy}
          onChange={(frames) => form.patch({ frames })}
        />

        {/* The rate is the model's own; it is shown, not chosen. */}
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-1 text-xs font-medium text-muted-foreground">
            <span className="truncate">{t('videos:form.frameRate')}</span>
            <ImageFieldHint>{t('videos:form.frameRateHint')}</ImageFieldHint>
          </span>
          <span
            className="shrink-0 font-mono text-sm tabular-nums"
            data-testid="video-frame-rate"
          >
            {t('videos:form.fps', { fps: lattice.fps })}
          </span>
        </div>

        <div className="flex flex-col gap-3.5 pt-1">
          <ImageParamSlider
            id="video-steps"
            label={t('videos:form.steps')}
            description={t('videos:form.stepsHint')}
            value={form.steps}
            min={minSteps}
            max={maxSteps}
            step={1}
            disabled={busy}
            onChange={(steps) => form.patch({ steps })}
          />
          {showGuidance && (
            <ImageParamSlider
              id="video-guidance"
              label={t('videos:form.guidance')}
              description={t('videos:form.guidanceHint')}
              value={form.cfgScale}
              min={1}
              max={20}
              step={0.5}
              disabled={busy}
              onChange={(cfgScale) => form.patch({ cfgScale })}
            />
          )}
          {showDistilledGuidance && (
            <ImageParamSlider
              id="video-distilled-guidance"
              label={t('videos:form.distilledGuidance')}
              description={t('videos:form.distilledGuidanceHint')}
              value={form.guidance ?? capabilities?.defaults.guidance ?? 3.5}
              min={0}
              max={20}
              step={0.5}
              disabled={busy}
              onChange={(guidance) => form.patch({ guidance })}
            />
          )}
        </div>

        <ImageSeedField
          id="video-seed"
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
              data-testid="video-advanced-toggle"
            >
              <span className="min-w-0 flex-1 text-xs font-medium">
                {t('videos:form.advanced')}
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
            data-testid="video-advanced-panel"
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
              <ImageApiSettingsCard variant="embedded" resource="videos" />
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

export default VideoPromptForm
