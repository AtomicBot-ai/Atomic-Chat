/**
 * The Media Studio.
 *
 * This is where every piece built in Tasks 1-10 finally meets. The v1 version
 * called `useAtomicMediaJob`, which held the job in `useState` - so the job
 * existed only while this component was mounted, and navigating away lost it
 * (coupling C10). It also spoke to exactly one hardcoded worker.
 *
 * Now: providers come from the provider store, the job lives in the
 * module-scoped job manager and outlives any render, outputs are materialised
 * to disk before the preview sees them (decision Q4), and the form is driven by
 * the model's own parameter schema rather than by hand-written controls.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import {
  MediaGenerationForm,
  type MediaInstallProgress,
} from './MediaGenerationForm'
import { MediaJobStatus } from './MediaJobStatus'
import { MediaPreview } from './MediaPreview'
import { useMediaGeneration } from '@/hooks/useMediaGeneration'
import { useMediaJobAsset } from '@/hooks/useMediaJobAsset'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useMediaProviderStore } from '@/stores/media-provider-store'
import { isTerminalMediaJobState } from '@/services/media/jobManager'
import { createMediaAdapter } from '@/services/media/providerFactory'
import {
  takePendingMediaReRun,
  type PendingMediaReRun,
} from '@/services/media/rerun'
import type {
  MediaDeviceDescriptor,
  MediaModelDescriptor,
  MediaTaskId,
  MediaTaskPresentation,
} from '@/services/media/contract'

export type MediaStudioProps = {
  /**
   * A link to the media library, supplied by the route.
   *
   * Injected rather than built here so this component stays renderable without
   * a router - which its own test relies on, and which keeps a routing concern
   * out of a component that is otherwise pure presentation.
   */
  libraryLink?: ReactNode
}

export function MediaStudio({ libraryLink }: MediaStudioProps = {}) {
  const { t } = useTranslation()
  const providers = useMediaProviderStore((state) => state.providers)
  const capabilities = useMediaProviderStore((state) => state.capabilities)
  const health = useMediaProviderStore((state) => state.health)
  const errors = useMediaProviderStore((state) => state.errors)
  const selectedModelId = useMediaProviderStore((state) => state.selectedModelId)
  const setSelectedModel = useMediaProviderStore(
    (state) => state.setSelectedModel
  )
  const refresh = useMediaProviderStore((state) => state.refresh)

  const { latest, submit, cancel } = useMediaGeneration()
  const [task, setTask] = useState<MediaTaskId | null>(null)

  /**
   * A generation handed over from the library (decision D17).
   *
   * Read in an effect rather than a `useState` initialiser: StrictMode invokes
   * an initialiser twice and discards the first result, which would consume the
   * handover and then throw it away. The ref makes the read happen once even
   * though the effect itself runs twice.
   */
  const [reRun, setReRun] = useState<PendingMediaReRun | undefined>()
  const consumedReRun = useRef(false)

  // Health is never persisted, so it has to be asked for on arrival.
  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (consumedReRun.current) return
    consumedReRun.current = true

    const pending = takePendingMediaReRun()
    if (!pending) return

    setReRun(pending)
    setTask(pending.task as MediaTaskId)
    setSelectedModel(pending.model_id)
  }, [setSelectedModel])

  const enabledProviders = useMemo(
    () => providers.filter((provider) => provider.enabled),
    [providers]
  )

  const models = useMemo(
    () =>
      enabledProviders.flatMap(
        (provider) => capabilities[provider.id]?.models ?? []
      ),
    [enabledProviders, capabilities]
  )

  /**
   * Every task any enabled provider can serve.
   *
   * Presentation is taken from the provider when it supplies it, and a task a
   * model claims without any presentation still gets an entry - a tab labelled
   * with its own id is worse than a pretty one, but far better than a model the
   * user has no way to reach. That omission is exactly coupling C3.
   */
  const tasks = useMemo<MediaTaskPresentation[]>(() => {
    const byId = new Map<string, MediaTaskPresentation>()

    for (const provider of enabledProviders) {
      for (const entry of capabilities[provider.id]?.tasks ?? []) {
        if (!byId.has(entry.id)) byId.set(entry.id, entry)
      }
    }
    for (const model of models) {
      for (const id of model.tasks) {
        if (!byId.has(id)) byId.set(id, { id, output_media_type: 'unknown' })
      }
    }

    return [...byId.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }, [enabledProviders, capabilities, models])

  const activeTask = task ?? tasks[0]?.id ?? ''

  const modelsForTask = useMemo(
    () => models.filter((model) => model.tasks.includes(activeTask)),
    [models, activeTask]
  )

  const selectedModel =
    modelsForTask.find((model) => model.id === selectedModelId) ??
    modelsForTask[0] ??
    null

  const selectedProvider =
    providers.find((provider) => provider.id === selectedModel?.provider_id) ??
    null

  const devices = useMemo<MediaDeviceDescriptor[]>(
    () =>
      selectedProvider
        ? (capabilities[selectedProvider.id]?.devices ?? [])
        : [],
    [selectedProvider, capabilities]
  )

  const busy = latest ? !isTerminalMediaJobState(latest.state) : false

  // Download a model in place (the built-in engine), then ask its provider
  // again so the model reads as installed and Generate appears.
  const installModel = async (
    model: MediaModelDescriptor,
    onProgress: (progress: MediaInstallProgress) => void
  ) => {
    const provider = providers.find((entry) => entry.id === model.provider_id)
    if (!provider) throw new Error(`No provider "${model.provider_id}" is set up.`)
    const adapter = createMediaAdapter(provider)
    if (!adapter.install) {
      throw new Error(`${provider.label} cannot download models.`)
    }
    await adapter.install(model.id, onProgress)
    await refresh({ providerId: provider.id })
  }
  const asset = useMediaJobAsset(latest, selectedModel?.label ?? '')

  const headerLabel = selectedProvider
    ? selectedModel
      ? `${selectedModel.label} · ${selectedProvider.label}`
      : selectedProvider.label
    : t('media:studio.noProvider', { defaultValue: 'No media provider' })

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-neutral-50 dark:bg-background">
      <div className="border-b border-border/50 px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {t('media:studio.brand', { defaultValue: 'Radium Media' })}
            </p>
            <h1 className="mt-0.5 font-studio text-xl font-medium text-foreground">
              {t('media:studio.title', { defaultValue: 'Media Studio' })}
            </h1>
            {libraryLink && (
              <div className="mt-1 text-xs text-muted-foreground">
                {libraryLink}
              </div>
            )}
          </div>
          <div className="rounded-full border border-border/60 bg-background px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
            {headerLabel}
          </div>
        </div>
      </div>

      {/* On a wide window each column scrolls on its own, so the settings get
          their own scroll bar (with arrows) beside the preview instead of
          being cut off (the user, 2026-09-15). The row must be capped at the
          grid's height (minmax(0,1fr)); an auto row grows to fit the content,
          so the columns never overflowed and no scroll bar appeared.
          Narrow windows scroll as one. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:overflow-hidden lg:p-5">
        <div className="mx-auto grid w-full max-w-[1500px] gap-4 lg:h-full lg:grid-cols-[minmax(320px,0.82fr)_minmax(440px,1.45fr)] lg:grid-rows-[minmax(0,1fr)]">
          <div
            className="lg:min-h-0 lg:overflow-y-auto lg:pr-2"
            data-testid="media-settings-column"
          >
          <MediaGenerationForm
            // Remounted when a re-run arrives, so the handed-over values
            // replace the model's defaults instead of losing to them.
            key={reRun ? `rerun:${reRun.model_id}:${activeTask}` : 'studio'}
            initialParams={reRun?.params}
            tasks={tasks}
            task={activeTask}
            onTaskChange={setTask}
            models={modelsForTask}
            providers={enabledProviders}
            devices={devices}
            selectedModelId={selectedModel?.id ?? null}
            onSelectModel={setSelectedModel}
            disabled={busy}
            onSubmit={submit}
            onInstallModel={installModel}
          />
          </div>

          <div className="flex min-h-0 flex-col gap-3 lg:overflow-y-auto">
            <MediaPreview asset={asset} />
            <MediaJobStatus
              job={latest ?? null}
              cancellable={latest?.cancellable ?? false}
              onCancel={cancel}
              providers={enabledProviders}
              health={health}
              errors={errors}
              onRetryProvider={(providerId) => refresh({ providerId })}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
