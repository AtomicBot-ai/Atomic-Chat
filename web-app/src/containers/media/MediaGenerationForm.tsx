/**
 * The generation form, driven entirely by the v2 contract.
 *
 * What used to be here: a hardcoded `MODES` list of three task tabs, and eight
 * hand-written control blocks - resolution, device, frames, fps, steps,
 * guidance, seed, input image, negative prompt - each one a bespoke `<input>`
 * with its own clamping. That is why adding a single parameter meant editing a
 * file frozen by the protected-surface guard (coupling C5), and why a model
 * offering `image_to_image` could not be reached at all: the tab simply did not
 * exist (coupling C3).
 *
 * What is here now: tabs come from what the providers declare, and the controls
 * come from `MediaParamGroups` walking the model's `MediaParamSpec[]`. A
 * provider that announces a parameter this build has never heard of still
 * renders it.
 *
 * Two things are deliberately NOT schema-driven, and both are structural rather
 * than model parameters:
 *  - Provider, model and device are selectors over the platform itself.
 *  - The prompt keeps its own composer card at the bottom, beside Generate.
 *    The schema still owns it - it is validated and submitted like any other
 *    param - it is only DRAWN somewhere else, so the primary input and its
 *    button do not end up at opposite ends of the panel. See decision D10.
 *
 * A model its provider can download but has not yet (the built-in engine,
 * Task 30) offers "Download model" in place of Generate, with progress, so the
 * Media page works on its own without a trip to Settings.
 */
import { useEffect, useMemo, useState } from 'react'
import { ulid } from 'ulidx'

import { cn } from '@/lib/utils'
import { validateParams } from '@/services/media/contract'
import type {
  MediaDeviceDescriptor,
  MediaModelDescriptor,
  MediaProviderDescriptor,
  MediaTaskId,
  MediaTaskPresentation,
  NormalizedMediaRequest,
} from '@/services/media/contract'

import { MediaParamGroups } from './params/MediaParamGroup'
import { useMediaParamState } from './params/useMediaParamState'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { fieldClass, labelClass } from './params/paramIdentity'
import { formatDownloadSize } from './downloadSize'
import { ImageFileInput } from './params/ImageFileInput'
import { MediaModelPicker } from './MediaModelPicker'

/** The one parameter drawn outside the grid. See D10. */
const PROMPT_PARAM = 'prompt'

export type MediaInstallProgress = { received: number; total?: number }

export type MediaGenerationFormProps = {
  /** Every task the enabled providers expose, for the tabs. */
  tasks: MediaTaskPresentation[]
  task: MediaTaskId
  onTaskChange: (task: MediaTaskId) => void
  /** Models offering the current task, across every enabled provider. */
  models: MediaModelDescriptor[]
  providers: MediaProviderDescriptor[]
  devices: MediaDeviceDescriptor[]
  selectedModelId: string | null
  onSelectModel: (modelId: string) => void
  disabled?: boolean
  /**
   * Values to start from instead of the model's defaults.
   *
   * Used by a re-run handed over from the library (decision D17): the point of
   * "Re-run" is that the form comes back EXACTLY as it was, so the defaults
   * must not win over what was actually generated. Applied at mount only - the
   * caller remounts via `key` when a new re-run arrives, because silently
   * overwriting a form the user is already typing into would be worse.
   */
  initialParams?: Record<string, unknown>
  onSubmit: (request: NormalizedMediaRequest) => void | Promise<unknown>
  /**
   * Download a model its provider can install. Resolves once it is installed;
   * the caller refreshes the provider so the model reads as installed.
   */
  onInstallModel?: (
    model: MediaModelDescriptor,
    onProgress: (progress: MediaInstallProgress) => void
  ) => Promise<void>
}

type InstallState =
  | { phase: 'idle' }
  | { phase: 'downloading'; modelId: string; percent: number | null }
  | { phase: 'failed'; modelId: string; detail: string }

/** Presentation label, falling back to the id so an unknown task still shows. */
function taskLabel(task: MediaTaskPresentation): string {
  return task.label ?? task.id
}

function byOrder<T extends { order?: number }>(a: T, b: T): number {
  return (a.order ?? 0) - (b.order ?? 0)
}

function needsDownload(model: MediaModelDescriptor | null): boolean {
  return Boolean(model?.install && !model.install.installed && model.install.installable)
}

export function MediaGenerationForm({
  tasks,
  task,
  onTaskChange,
  models,
  providers,
  devices,
  selectedModelId,
  onSelectModel,
  disabled = false,
  initialParams,
  onSubmit,
  onInstallModel,
}: MediaGenerationFormProps) {
  // Which provider's models the model select is showing. Null means "follow
  // the selected model", so the two stay in step until the user says otherwise.
  const [providerOverride, setProviderOverride] = useState<string | null>(null)
  const [device, setDevice] = useState('')
  const [install, setInstall] = useState<InstallState>({ phase: 'idle' })

  const orderedTasks = useMemo(() => [...tasks].sort(byOrder), [tasks])

  const selectedModel =
    models.find((model) => model.id === selectedModelId) ?? null

  // Only providers that can actually serve this task. Listing one that cannot
  // would offer a choice that empties the model list.
  const offeringProviders = useMemo(
    () =>
      providers.filter((provider) =>
        models.some((model) => model.provider_id === provider.id)
      ),
    [providers, models]
  )

  const activeProviderId =
    providerOverride ??
    selectedModel?.provider_id ??
    offeringProviders[0]?.id ??
    ''

  const providerModels = useMemo(
    () => models.filter((model) => model.provider_id === activeProviderId),
    [models, activeProviderId]
  )

  // A selection belonging to another provider must not sit in this select as a
  // value with no matching option.
  const shownModelId = providerModels.some(
    (model) => model.id === selectedModelId
  )
    ? (selectedModelId ?? '')
    : (providerModels[0]?.id ?? '')

  const activeModel =
    providerModels.find((model) => model.id === shownModelId) ?? null

  const specs = useMemo(
    () => (activeModel ? (activeModel.params[task] ?? []) : []),
    [activeModel, task]
  )
  // The model's first image parameter (a starting image, or a video's first
  // frame) is attached beside the prompt, like a file in a chat message
  // (the user, 2026-09-15: "text prompt with add file option").
  const attachSpec = useMemo(
    () =>
      specs.find((spec) => spec.type === 'image_ref' && spec.accept?.length) ??
      null,
    [specs]
  )
  const gridSpecs = useMemo(
    () =>
      specs.filter(
        (spec) => spec.id !== PROMPT_PARAM && spec.id !== attachSpec?.id
      ),
    [specs, attachSpec]
  )

  const { t } = useTranslation()
  const { values, setValue, blur } = useMediaParamState(specs, initialParams)

  // The model's required device wins, then the first one offered. v1 did
  // exactly this, and the submitted body carries the result, so choosing
  // differently here would silently change every request. Keyed on the model
  // and the device list rather than run once, because switching model can
  // change which device is required.
  const requiredDevice = activeModel?.fitness?.required_device
  const firstDevice = devices[0]?.id
  useEffect(() => {
    setDevice(requiredDevice ?? firstDevice ?? '')
  }, [requiredDevice, firstDevice])

  const mustDownload = needsDownload(activeModel) && Boolean(onInstallModel)
  const downloading =
    install.phase === 'downloading' && install.modelId === activeModel?.id
  const downloadSize = formatDownloadSize(activeModel?.install?.size_bytes)

  const prompt = String(values[PROMPT_PARAM] ?? '')
  const formDisabled = disabled || !activeModel
  const canGenerate = !formDisabled && !mustDownload && prompt.trim().length > 0

  const handleProviderChange = (providerId: string) => {
    setProviderOverride(providerId)
    const first = models.find((model) => model.provider_id === providerId)
    if (first) onSelectModel(first.id)
  }

  const submit = () => {
    if (!activeModel) return

    // The same function the renderer uses to decide what to draw, so what is
    // submitted can never disagree with what was shown.
    const result = validateParams(specs, values)
    if (!result.ok) return

    void onSubmit({
      client_job_id: ulid(),
      provider_id: activeModel.provider_id,
      model_id: activeModel.id,
      task,
      params: result.values,
      ...(device ? { device } : {}),
    })
  }

  const download = async () => {
    if (!activeModel || !onInstallModel) return
    const modelId = activeModel.id
    setInstall({ phase: 'downloading', modelId, percent: null })
    try {
      await onInstallModel(activeModel, ({ received, total }) => {
        setInstall({
          phase: 'downloading',
          modelId,
          percent: total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
        })
      })
      setInstall({ phase: 'idle' })
    } catch (error) {
      setInstall({
        phase: 'failed',
        modelId,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="rounded-xl border border-border/60 bg-background p-4 shadow-sm">
        <div
          role="tablist"
          aria-label={t('media:form.task', { defaultValue: 'Generation task' })}
          className="mb-4 flex items-center gap-1 rounded-lg bg-muted/70 p-1"
        >
          {orderedTasks.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={entry.id === task}
              onClick={() => onTaskChange(entry.id)}
              className={cn(
                'flex-1 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground transition',
                entry.id === task &&
                  'bg-background text-foreground shadow-sm ring-1 ring-border/60'
              )}
            >
              {taskLabel(entry)}
            </button>
          ))}
        </div>

        {providerModels.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 p-4">
            <p className="text-sm font-medium text-foreground">
              No models available for this task
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Install a compatible model, or enable another provider in
              Settings, then refresh.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="media-provider" className={labelClass}>
                Provider
              </label>
              <select
                id="media-provider"
                aria-label={t('media:form.provider', { defaultValue: 'Provider' })}
                className={fieldClass}
                value={activeProviderId}
                onChange={(event) => handleProviderChange(event.target.value)}
                disabled={disabled || downloading}
              >
                {offeringProviders.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="media-model" className={labelClass}>
                Model
              </label>
              <MediaModelPicker
                id="media-model"
                ariaLabel={t('media:form.model', { defaultValue: 'Model' })}
                models={providerModels}
                selectedId={shownModelId}
                onSelect={onSelectModel}
                disabled={disabled || downloading}
              />
            </div>

            {/* The download right under the model picker, so it is found without
                scrolling to Generate (the user, 2026-09-15). */}
            {mustDownload && activeModel ? (
              <div
                className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border/70 px-3 py-2 sm:col-span-2"
                data-testid="media-model-download"
              >
                <span className="text-xs text-muted-foreground">
                  {downloading
                    ? install.phase === 'downloading' && install.percent !== null
                      ? t('media:form.downloadingPercent', {
                          percent: install.percent,
                          defaultValue: 'Downloading the model… {{percent}}%',
                        })
                      : t('media:form.downloading', { defaultValue: 'Downloading the model…' })
                    : install.phase === 'failed' && install.modelId === activeModel.id
                      ? t('media:form.downloadFailedShort', {
                          detail: install.detail,
                          defaultValue: 'Download failed: {{detail}}',
                        })
                      : t('media:form.notDownloadedYet', {
                        model: activeModel.label,
                        defaultValue: '{{model}} is not downloaded yet',
                      })}
                </span>
                {!downloading && (
                  <button
                    type="button"
                    onClick={() => void download()}
                    disabled={disabled}
                    className="shrink-0 rounded-full bg-foreground px-3 py-1.5 text-xs font-semibold text-background transition hover:opacity-90 disabled:opacity-40"
                  >
                    {downloadSize
                      ? t('media:form.downloadShort', {
                          size: downloadSize,
                          defaultValue: 'Download ({{size}})',
                        })
                      : t('media:form.downloadModel', { defaultValue: 'Download model' })}
                  </button>
                )}
              </div>
            ) : null}

            {devices.length ? (
              <div>
                <label htmlFor="media-device" className={labelClass}>
                  Device
                </label>
                <select
                  id="media-device"
                  aria-label={t('media:form.device', { defaultValue: 'Device' })}
                  className={fieldClass}
                  value={device}
                  onChange={(event) => setDevice(event.target.value)}
                  disabled={formDisabled}
                >
                  {devices.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="sm:col-span-2">
              <MediaParamGroups
                specs={gridSpecs}
                values={values}
                disabled={formDisabled}
                onChange={setValue}
                onBlur={blur}
              />
            </div>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-border/70 bg-background p-3 shadow-sm">
        <label htmlFor="media-prompt" className="sr-only">
          Prompt
        </label>
        <textarea
          id="media-prompt"
          aria-label={t('media:form.prompt', { defaultValue: 'Prompt' })}
          className="min-h-24 w-full resize-none bg-transparent px-1 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          placeholder="Describe what you want to create..."
          value={prompt}
          onChange={(event) => setValue(PROMPT_PARAM, event.target.value)}
          disabled={formDisabled}
        />
        {install.phase === 'failed' && install.modelId === activeModel?.id && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {t('media:form.downloadFailed', {
              detail: install.detail,
              defaultValue: 'The download did not finish: {{detail}}',
            })}
          </p>
        )}
        <div className="mt-2 flex items-center justify-between gap-3">
          {attachSpec ? (
            <ImageFileInput
              compact
              id="media-attach-file"
              label={attachSpec.label ?? 'Image'}
              accept={attachSpec.accept}
              value={values[attachSpec.id]}
              disabled={formDisabled || mustDownload}
              onChange={(next) => setValue(attachSpec.id, next)}
            />
          ) : null}
          <div className="min-w-0 flex-1 text-xs text-muted-foreground" data-testid="media-form-status">
            {downloading
              ? install.phase === 'downloading' && install.percent !== null
                ? t('media:form.downloadingPercent', {
                    percent: install.percent,
                    defaultValue: 'Downloading the model… {{percent}}%',
                  })
                : t('media:form.downloading', { defaultValue: 'Downloading the model…' })
              : mustDownload && activeModel
                ? t('media:form.downloadFirst', {
                    model: activeModel.label,
                    defaultValue: 'Download {{model}} to start making images with it',
                  })
                : activeModel
                  ? t('media:form.generatingWith', {
                      model: activeModel.label,
                      defaultValue: 'Generating with {{model}}',
                    })
                  : t('media:form.selectModel', {
                      defaultValue: 'Select a model to begin',
                    })}
          </div>
          {mustDownload ? (
            <button
              type="button"
              onClick={() => void download()}
              disabled={disabled || downloading}
              className="rounded-full bg-foreground px-4 py-2 text-xs font-semibold text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {downloading
                ? t('media:form.downloadingButton', { defaultValue: 'Downloading…' })
                : downloadSize
                  ? t('media:form.downloadModelSized', {
                      size: downloadSize,
                      defaultValue: 'Download model ({{size}})',
                    })
                  : t('media:form.downloadModel', { defaultValue: 'Download model' })}
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canGenerate}
              className="rounded-full bg-foreground px-4 py-2 text-xs font-semibold text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Generate
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
