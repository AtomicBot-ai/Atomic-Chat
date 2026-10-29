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
import { route } from '@/constants/routes'
import {
  MAX_IMAGE_BATCH,
  MAX_IMAGE_RUNS,
  useImageForm,
} from '@/hooks/useImageForm'
import { useImageGeneration } from '@/hooks/useImageGeneration'
import { useImageEngine } from '@/hooks/useImageEngine'
import { useRemoteMediaForm } from '@/hooks/useRemoteMediaForm'
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
import {
  IMAGE_WORKFLOWS,
  workflowPath,
  workflowSpec,
} from '@/lib/diffusion/workflows'
import { cn } from '@/lib/utils'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImageField, ImageFieldHint } from './ImageField'
import { ImageApiSettingsCard } from './ImageApiSettingsCard'
import { ImageWorkflowInputs } from './ImageWorkflowInputs'
import { MediaModeSelect } from './MediaModeSelect'
import { MediaSettingsHeading } from './MediaSettingsHeading'
import { MediaPageHeading } from './MediaPageHeading'
import { MediaPromptCard } from './MediaStudio'
import { WORKFLOW_ICONS } from './workflowIcons'
import { ConfirmImageExceedsMemory } from './ConfirmImageExceedsMemory'
import { ImageGenerateButton } from './ImageGenerateButton'
import { ImageModelPicker } from './ImageModelPicker'
import { AdvancedSelect } from './AdvancedSelect'
import { ImageParamSlider } from './ImageParamSlider'
import { ImageSeedField } from './ImageSeedField'
import { ImageSizeControl } from './ImageSizeControl'
import { RemoteImageOptionsFields } from './RemoteImageOptionsFields'

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
      adoptModel: state.adoptModel,
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
  const applyIdleSettings = useImageGenerationStore(
    (state) => state.applyIdleSettings
  )
  const generation = useImageGeneration()
  // The picked model's, known from the catalog before it starts: the
  // controls it needs are there at once and do not appear on load.
  const { capabilities, targetFamilyId, remote } = generation
  // A provider's model: only the controls its descriptor lists exist.
  const remoteParams = remote?.descriptor.params
  const [internalModelsOpen, setInternalModelsOpen] = useState(false)
  const modelsOpen = controlledModelsOpen ?? internalModelsOpen
  const setModelsOpen = onModelsOpenChange ?? setInternalModelsOpen

  // A model was picked or loaded: the draft becomes its. Starting the
  // picked model changes nothing the user set, only the model's report.
  useEffect(() => {
    if (targetFamilyId && capabilities)
      form.adoptModel(targetFamilyId, capabilities)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetFamilyId, capabilities])

  const constraints: DimConstraints = capabilities
    ? {
        minDim: capabilities.minDim,
        maxDim: capabilities.maxDim,
        dimMultiple: capabilities.dimMultiple,
      }
    : FALLBACK_CONSTRAINTS
  const [minSteps, maxSteps] = capabilities?.ranges.steps ?? FALLBACK_STEPS
  const maxBatch = Math.max(1, capabilities?.maxBatch ?? MAX_IMAGE_BATCH)
  const spec = workflowSpec(form.workflow)
  const showNegative = capabilities?.supportsNegativePrompt ?? false
  // Families distilled to run at cfg 1 have no classifier-free guidance to
  // tune; the slider would be a knob that does nothing.
  const showCfg = remote
    ? remoteParams?.cfg !== undefined
    : !capabilities ||
      capabilities.defaults.cfgScale > 1 ||
      capabilities.supportsNegativePrompt
  const [minCfg, maxCfg] = remoteParams?.cfg
    ? [remoteParams.cfg.min, remoteParams.cfg.max]
    : [1, 20]
  const showSteps = !remote || remoteParams?.steps !== undefined
  const showSeed = !remote || remoteParams?.seed === true
  // A provider's model with a list of sizes, or aspect ratios, takes them from the remote fields.
  const showSize =
    spec.usesResolution && (!remote || remoteParams?.size?.kind === 'range')
  const showGuidance = capabilities?.supportsGuidance ?? false
  const busy = generation.generating
  const remoteWorkflows = remote?.descriptor.workflows
  const modes = useMemo(
    () =>
      IMAGE_WORKFLOWS.map(({ id }) => ({
        id,
        icon: WORKFLOW_ICONS[id],
        title: t(`images:workflow.${id}.title`),
        hint: t(`images:workflow.${id}.hint`),
        // Still selectable: the picker then offers the models that can.
        ...(remoteWorkflows && !remoteWorkflows.some((w) => w === id)
          ? { badge: t('images:remote.otherModel') }
          : {}),
      })),
    [t, remoteWorkflows]
  )
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
        {/* The sidebar and the heading name the section; the Mode field
            under them picks what the column does. */}
        <div className="flex flex-col gap-4">
          <MediaPageHeading
            title={t('images:page.title')}
            subtitle={t('images:page.subtitle')}
            testIdPrefix="image"
          />
          {/* The route stays the source of truth, so a pick navigates. */}
          <MediaModeSelect
            modes={modes}
            value={form.workflow}
            onChange={(id) => navigate({ to: workflowPath(id) })}
            label={t('images:workflow.choose')}
            testIdPrefix="image"
          />
        </div>

        <ImageWorkflowInputs
          workflow={form.workflow}
          constraints={constraints}
          outputSize={generation.outputSize}
          disabled={busy}
        />

        <MediaPromptCard testId="image-prompt-card">
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
          {/* Portalled out of the form: its buttons never submit it. */}
          {generation.confirmation && (
            <ConfirmImageExceedsMemory {...generation.confirmation} />
          )}
        </MediaPromptCard>

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

        {/* Reset sits over what it puts back; the prompts stay. */}
        <MediaSettingsHeading
          label={t('common:settings')}
          resetLabel={t('images:form.reset')}
          resetHint={t('images:form.resetHint')}
          onReset={
            capabilities
              ? () => {
                  form.resetToDefaults(capabilities.defaults)
                  if (remote) useRemoteMediaForm.setState({ image: {} })
                }
              : undefined
          }
          disabled={busy}
          testIdPrefix="image"
        />

        {/* Inpaint, extend, upscale and edit take their size from the
            source; a size control there would be a knob that does nothing. */}
        {showSize && (
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

        {remote && (
          <RemoteImageOptionsFields
            descriptor={remote.descriptor}
            disabled={busy}
          />
        )}

        {/* The one-line sliders, a touch apart from the fields above. */}
        <div className="flex flex-col gap-3.5 pt-1">
          {showSteps && (
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
          )}
          {showCfg && (
            <ImageParamSlider
              id="image-cfg"
              label={t('images:form.cfgScale')}
              description={t('images:form.cfgScaleHint')}
              value={form.cfgScale}
              min={minCfg}
              max={maxCfg}
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

        {showSeed && (
          <ImageSeedField
            value={form.seedText}
            disabled={busy}
            onChange={(seedText) => form.patch({ seedText })}
          />
        )}

        {/* The load-time options are the local engine's; a provider's model has none. */}
        {!remote && (
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
        )}
      </div>
    </form>
  )
})

export default ImagePromptForm
