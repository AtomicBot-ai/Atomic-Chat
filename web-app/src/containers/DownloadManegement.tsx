import { useDownloadStore, type DownloadStage } from '@/hooks/useDownloadStore'
import { useAppUpdater } from '@/hooks/useAppUpdater'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useProxyConfig } from '@/hooks/useProxyConfig'
import { useServiceHub } from '@/hooks/useServiceHub'
import { DownloadEvent, DownloadState, events, AppEvent } from '@janhq/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { IconCheck } from '@tabler/icons-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { DownloadPanel } from '@/containers/downloads/DownloadPanel'
import type { DownloadRowProps } from '@/containers/downloads/DownloadProgressRow'
import { advanceSpeedSample, newSpeedSample } from '@/lib/downloadFormat'
import {
  cancelDownload,
  clearDownloadCancellationRequested,
  isDownloadCancellationError,
  wasDownloadCancellationRequested,
} from '@/lib/downloadCancellation'
import {
  classifyDownloadFailure,
  downloadKind,
  finalizeDownloadOnce,
  markModelDownloaded,
  normalizeModelId,
  parseHttpStatus,
  quantFromModelId,
  scrubPii,
  sizeBucket,
  takeDownloadDuration,
} from '@/lib/telemetry'
import { queuedCapture } from '@/lib/telemetry-queue'
import { captureHandledError } from '@/lib/sentry'
import {
  downloadArtifact,
  isDiffusionModelDownloadTaskId,
  resolveDiffusionDownloadTaskId,
} from '@/lib/diffusion/models'
import { cancelTransfer } from '@/services/diffusion/transfer'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useImageForm } from '@/hooks/useImageForm'

type DiffusionDownloadKind = 'model' | 'engine'

function diffusionDownloadKind(id: string): DiffusionDownloadKind | null {
  if (id.startsWith('diffusion-model-')) return 'model'
  if (id.startsWith('diffusion-backend-')) return 'engine'
  return null
}

/**
 * ATO-109: emit the terminal `model_download` event. Deduplicated so the two
 * success events don't double-count. PII contract: only ids/enums/buckets.
 */
function captureDownloadTerminal(
  status: 'completed' | 'failed' | 'cancelled',
  id: string,
  opts: { downloadType?: string; error?: string; totalBytes?: number } = {}
): void {
  if (!finalizeDownloadOnce(id)) return

  const kind = downloadKind(id, opts.downloadType)
  if (status === 'completed' && kind === 'model') {
    markModelDownloaded(id)
  }

  try {
    queuedCapture('model_download', {
      // NOT `status` — that name is globally typed numeric in PostHog by
      // `api_server_request.status` (an HTTP code), so string values read back
      // as null. See the same note in `switchModel.ts`.
      download_status: status,
      download_kind: kind,
      model_id: normalizeModelId(id),
      quant: quantFromModelId(id),
      size_bucket: sizeBucket(opts.totalBytes),
      duration_ms: takeDownloadDuration(id),
      failure_reason:
        status === 'completed'
          ? undefined
          : classifyDownloadFailure(opts.error),
      http_status: parseHttpStatus(opts.error),
    })
  } catch (telemetryError) {
    console.debug('model_download terminal telemetry failed:', telemetryError)
  }
}

export function DownloadManagement() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const prevDownloadCount = useRef(0)
  // ATO-462 verification: how long the panel actually stayed expanded while
  // something was downloading. Accumulated here (the panel owns the collapsed
  // flag but not the download lifecycle) and reported once per download run.
  const panelTiming = useRef({
    collapsed: false,
    since: 0,
    expandedMs: 0,
    collapsedMs: 0,
    peakDownloads: 0,
  })
  const serviceHub = useServiceHub()
  const imageCatalog = useImageGenerationStore((state) => state.catalog)
  const huggingfaceToken = useGeneralSetting((state) => state.huggingfaceToken)
  const {
    downloads,
    updateProgress,
    updateStage,
    localDownloadingModels,
    removeDownload,
    removeLocalDownloadingModel,
    markResumableDownload,
    clearResumableDownload,
    pausedDownloads,
    markPausedDownload,
    clearPausedDownload,
    resumeParams,
    clearResumeParams,
    clearDownloadOrigin,
  } = useDownloadStore()
  const { updateState } = useAppUpdater()

  const [appUpdateState, setAppUpdateState] = useState({
    isDownloading: false,
    downloadProgress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
  })

  // The app updater keeps its progress in component state rather than in the
  // download store, so its speed is sampled here — with the same estimator, so
  // the two kinds of row cannot report speed differently.
  const appUpdateSample = useRef(newSpeedSample())
  const [appUpdateBps, setAppUpdateBps] = useState(0)

  useEffect(() => {
    if (!appUpdateState.isDownloading) {
      appUpdateSample.current = newSpeedSample()
      setAppUpdateBps(0)
      return
    }
    appUpdateSample.current = advanceSpeedSample(
      appUpdateSample.current,
      appUpdateState.downloadedBytes
    )
    setAppUpdateBps(appUpdateSample.current.bytesPerSecond)
  }, [appUpdateState.isDownloading, appUpdateState.downloadedBytes])

  useEffect(() => {
    setAppUpdateState({
      isDownloading: updateState.isDownloading,
      downloadProgress: updateState.downloadProgress,
      downloadedBytes: updateState.downloadedBytes,
      totalBytes: updateState.totalBytes,
    })
  }, [updateState])

  const onAppUpdateDownloadUpdate = useCallback(
    (data: {
      progress?: number
      downloadedBytes?: number
      totalBytes?: number
    }) => {
      setAppUpdateState((prev) => ({
        ...prev,
        isDownloading: true,
        downloadProgress: data.progress || 0,
        downloadedBytes: data.downloadedBytes || 0,
        totalBytes: data.totalBytes || 0,
      }))
    },
    []
  )

  const onAppUpdateDownloadSuccess = useCallback(() => {
    setAppUpdateState((prev) => ({
      ...prev,
      isDownloading: false,
      downloadProgress: 1,
    }))
    toast.success(t('common:toast.appUpdateDownloaded.title'), {
      description: t('common:toast.appUpdateDownloaded.description'),
    })
  }, [t])

  const onAppUpdateDownloadError = useCallback(() => {
    setAppUpdateState((prev) => ({
      ...prev,
      isDownloading: false,
    }))
    toast.error(t('common:toast.appUpdateDownloadFailed.title'), {
      description: t('common:toast.appUpdateDownloadFailed.description'),
    })
  }, [t])

  const downloadProcesses = useMemo(() => {
    // Get downloads with progress data
    const downloadsWithProgress = Object.entries(downloads).map(
      ([downloadKey, download]) => {
        // Early progress events can arrive before the backend fills `name` or
        // even the mirrored `id`. The store key is still the requested model,
        // so use it rather than rendering a nameless percentage-only row.
        const modelId = download.id || download.name || downloadKey
        return {
          id: modelId,
          name: modelId,
          progress: download.progress,
          current: download.current,
          total: download.total,
          bytesPerSecond: download.speed?.bytesPerSecond ?? 0,
          stage: download.stage,
        }
      }
    )
    const progressIds = new Set(
      downloadsWithProgress.map((download) => download.id)
    )

    // Add local downloading models that don't have progress data yet
    const localDownloadsWithoutProgress = Array.from(localDownloadingModels)
      .filter((modelId) => !progressIds.has(modelId))
      .map((modelId) => ({
        id: modelId,
        name: modelId,
        progress: 0,
        current: 0,
        total: 0,
        bytesPerSecond: 0,
      }))

    return [...downloadsWithProgress, ...localDownloadsWithoutProgress]
  }, [downloads, localDownloadingModels])

  const downloadCount = useMemo(() => {
    const modelDownloads = downloadProcesses.length
    const appUpdateDownload = appUpdateState.isDownloading ? 1 : 0
    const total = modelDownloads + appUpdateDownload
    return total
  }, [downloadProcesses, appUpdateState.isDownloading])

  // ATO-462: each download run starts expanded and stays present while active;
  // a deliberate collapse lasts for that run. Measure how much of the run the
  // user actually kept expanded, which is the number this redesign should move.
  const settlePanelTiming = useCallback(() => {
    const timing = panelTiming.current
    if (!timing.since) return
    const elapsed = Date.now() - timing.since
    if (timing.collapsed) timing.collapsedMs += elapsed
    else timing.expandedMs += elapsed
    timing.since = Date.now()
  }, [])

  const onPanelCollapsedChange = useCallback(
    (collapsed: boolean) => {
      settlePanelTiming()
      panelTiming.current.collapsed = collapsed
    },
    [settlePanelTiming]
  )

  useEffect(() => {
    const prev = prevDownloadCount.current
    prevDownloadCount.current = downloadCount

    const timing = panelTiming.current
    timing.peakDownloads = Math.max(timing.peakDownloads, downloadCount)

    if (downloadCount > 0 && prev === 0) {
      timing.since = Date.now()
      timing.expandedMs = 0
      timing.collapsedMs = 0
      timing.peakDownloads = downloadCount
      return
    }

    if (downloadCount === 0 && prev > 0) {
      settlePanelTiming()
      queuedCapture('download_panel_visibility', {
        expanded_ms: Math.round(timing.expandedMs),
        collapsed_ms: Math.round(timing.collapsedMs),
        collapsed_at_end: timing.collapsed,
        peak_downloads: timing.peakDownloads,
      })
      timing.since = 0
      timing.expandedMs = 0
      timing.collapsedMs = 0
      timing.peakDownloads = 0
    }
  }, [downloadCount, settlePanelTiming])

  const onFileDownloadUpdate = useCallback(
    async (state: DownloadState) => {
      // The downloader also emits status-only updates while its retry ladders
      // run (`stage`), which carry no byte counts. Feeding those through
      // `updateProgress` would publish 0/0 and rewind the bar (#290).
      const stage = (state as unknown as { stage?: DownloadStage }).stage
      if (stage) {
        updateStage(state.modelId, stage)
        return
      }
      updateProgress(
        state.modelId,
        state.percent,
        state.modelId,
        state.size?.transferred,
        state.size?.total
      )
    },
    [updateProgress, updateStage]
  )

  const onFileDownloadError = useCallback(
    (state: DownloadState) => {
      console.debug('onFileDownloadError', state)

      const anyState = state as unknown as {
        error?: string
        downloadType?: string
      }
      const err = anyState?.error || ''

      // The Rust downloader opens the "verifying…" toast itself and never
      // closes it. A failure that lands after it (disk error while hashing, a
      // cancelled check) used to leave that toast spinning forever next to a
      // download that had already ended.
      toast.dismiss(`model-validation-started-${state.modelId}`)

      // Stopping a diffusion transfer for Pause rejects its in-flight
      // download promise. Keep the row and its last progress intact; a real
      // network/disk failure while paused still follows the normal path.
      if (
        useDownloadStore.getState().pausedDownloads.has(state.modelId) &&
        isDownloadCancellationError(err)
      ) {
        markResumableDownload(state.modelId)
        return
      }

      clearPausedDownload(state.modelId)
      clearResumeParams(state.modelId)
      removeDownload(state.modelId)
      removeLocalDownloadingModel(state.modelId)
      clearDownloadOrigin(state.modelId)

      const cancelled =
        wasDownloadCancellationRequested(state.modelId) ||
        isDownloadCancellationError(err)
      captureDownloadTerminal(
        cancelled ? 'cancelled' : 'failed',
        state.modelId,
        {
          downloadType: anyState?.downloadType,
          error: err,
          totalBytes: state.size?.total,
        }
      )

      if (cancelled) {
        markResumableDownload(state.modelId)
        toast.dismiss('download-failed')
        return
      }

      // ATO-113: report genuine download failures to Sentry with zero-PII tags
      // (classification enums + http status only; the raw error string carries
      // URLs/tokens and is scrubbed by beforeSend before leaving the device).
      captureHandledError(
        anyState?.error ? new Error(scrubPii(err)) : 'model_download failed',
        'error',
        {
          feature: 'model_download',
          failure_reason: classifyDownloadFailure(err),
          http_status: parseHttpStatus(err),
          download_kind: downloadKind(state.modelId, anyState?.downloadType),
          model_id: normalizeModelId(state.modelId),
          quant: quantFromModelId(state.modelId),
        }
      )

      if (err.includes('HTTP status 401')) {
        clearResumableDownload(state.modelId)
        toast.error('Hugging Face token required', {
          id: 'download-failed',
          description:
            'This model requires a Hugging Face access token. Add your token in Settings and retry.',
          action: {
            label: 'Open Settings',
            onClick: () => navigate({ to: route.settings.general }),
          },
        })
        return
      }

      if (err.includes('HTTP status 403')) {
        clearResumableDownload(state.modelId)
        toast.error('Accept model license on Hugging Face', {
          id: 'download-failed',
          description:
            'You must accept the model’s license on its Hugging Face page before downloading.',
        })
        return
      }

      if (err.includes('HTTP status 429')) {
        markResumableDownload(state.modelId)
        toast.error('Rate limited by Hugging Face', {
          id: 'download-failed',
          description:
            'You have been rate-limited. Adding a token can increase rate limits. Please try again later.',
          action: {
            label: 'Open Settings',
            onClick: () => navigate({ to: route.settings.general }),
          },
        })
        return
      }

      // ATO-467: a filesystem failure now says which one it was. The generic
      // "download failed" toast told 647 devices nothing they could act on,
      // and disk faults are the single largest failure cause.
      const diskReason = classifyDownloadFailure(err)
      const diskToastKey: Record<string, string> = {
        disk_full: 'common:toast.downloadDiskFull',
        disk_permission: 'common:toast.downloadDiskPermission',
        disk_file_locked: 'common:toast.downloadDiskLocked',
        disk_path_too_long: 'common:toast.downloadDiskPathTooLong',
        disk_device_lost: 'common:toast.downloadDiskDeviceLost',
      }
      const diskKey = diskToastKey[diskReason]
      if (diskKey) {
        markResumableDownload(state.modelId)
        toast.error(t(`${diskKey}.title`), {
          id: 'download-failed',
          description: t(`${diskKey}.description`),
          duration: 30000,
        })
        return
      }

      // ATO — #290: a download that never reached the server is not a generic
      // failure, and when the user has a proxy configured it is overwhelmingly
      // the cause. Naming it (and offering the settings page) is the whole
      // difference between "it just doesn't work" and a one-click fix.
      if (diskReason === 'proxy' || diskReason === 'network') {
        markResumableDownload(state.modelId)
        const viaProxy =
          diskReason === 'proxy' ||
          (useProxyConfig.getState().proxyEnabled &&
            Boolean(useProxyConfig.getState().proxyUrl))
        if (viaProxy) {
          toast.error(t('common:toast.downloadProxyUnreachable.title'), {
            id: 'download-failed',
            description: t(
              'common:toast.downloadProxyUnreachable.description',
              {
                proxyUrl: useProxyConfig.getState().proxyUrl,
              }
            ),
            duration: 30000,
            action: {
              label: t('common:toast.downloadProxyUnreachable.action'),
              onClick: () => navigate({ to: route.settings.https_proxy }),
            },
          })
        } else {
          toast.error(t('common:toast.downloadNetworkUnreachable.title'), {
            id: 'download-failed',
            description: t(
              'common:toast.downloadNetworkUnreachable.description'
            ),
            duration: 30000,
          })
        }
        return
      }

      markResumableDownload(state.modelId)
      toast.error(t('common:toast.downloadFailed.title'), {
        id: 'download-failed',
        description: t('common:toast.downloadFailed.description', {
          item: state.modelId,
        }),
      })
    },
    [
      removeDownload,
      removeLocalDownloadingModel,
      markResumableDownload,
      clearResumableDownload,
      clearPausedDownload,
      clearResumeParams,
      clearDownloadOrigin,
      t,
      navigate,
    ]
  )

  const onModelValidationStarted = useCallback(
    (event: { modelId: string; downloadType: string }) => {
      console.debug('onModelValidationStarted', event)

      const diffusionKind = diffusionDownloadKind(event.modelId)
      if (diffusionKind) {
        const description =
          diffusionKind === 'model' ? (
            <span className="block">
              <span className="block">
                {t('images:download.checkingFiles')}
              </span>
              <span className="block whitespace-nowrap">
                {t('images:download.readyAfterCheck')}
              </span>
            </span>
          ) : (
            t('images:download.checkingFiles')
          )
        toast.loading(
          t(
            diffusionKind === 'model'
              ? 'images:download.finishingModel'
              : 'images:download.finishingEngine'
          ),
          {
            id: `model-validation-started-${event.modelId}`,
            description,
            duration: Infinity,
          }
        )
        return
      }

      // Show validation in progress toast
      toast.info(t('common:toast.modelValidationStarted.title'), {
        id: `model-validation-started-${event.modelId}`,
        description: t('common:toast.modelValidationStarted.description', {
          modelId: event.modelId,
        }),
        duration: Infinity,
      })
    },
    [t]
  )

  const onModelValidationFailed = useCallback(
    (event: { modelId: string; error: string; reason: string }) => {
      console.debug('onModelValidationFailed', event)

      // Dismiss the validation started toast
      toast.dismiss(`model-validation-started-${event.modelId}`)

      captureDownloadTerminal('failed', event.modelId, {
        downloadType: 'Model',
        error: event.error || event.reason,
        // The only terminal site that reported no size, so every
        // validation failure landed in `size_bucket: 'unknown'` — and size is
        // exactly what a hash/size mismatch is about. The transfer finished
        // before validation ran, so the store still has the total.
        totalBytes: useDownloadStore.getState().downloads[event.modelId]?.total,
      })

      clearResumableDownload(event.modelId)
      clearPausedDownload(event.modelId)
      clearResumeParams(event.modelId)
      removeDownload(event.modelId)
      removeLocalDownloadingModel(event.modelId)
      clearDownloadOrigin(event.modelId)

      // Show specific toast for validation failure
      toast.error(t('common:toast.modelValidationFailed.title'), {
        description: t('common:toast.modelValidationFailed.description', {
          modelId: event.modelId,
        }),
        duration: 30000,
      })
    },
    [
      removeDownload,
      removeLocalDownloadingModel,
      clearResumableDownload,
      clearPausedDownload,
      clearResumeParams,
      clearDownloadOrigin,
      t,
    ]
  )

  const onFileDownloadStopped = useCallback(
    (state: DownloadState) => {
      console.debug('onFileDownloadStopped', state)

      toast.dismiss(`model-validation-started-${state.modelId}`)

      // ATO-154: a paused download stops the transfer but is not a terminal
      // event. Keep the `downloads[modelId]` entry (so the popover row survives
      // with its last progress + a Resume button) and skip the cancelled
      // telemetry/toast/cleanup. The partial file is kept on disk by the Rust
      // downloader, so resume continues from where it stopped. Read paused
      // state from the store directly (not the closure) so the async stop
      // event can't race a stale render of `pausedDownloads`.
      if (useDownloadStore.getState().pausedDownloads.has(state.modelId)) {
        markResumableDownload(state.modelId)
        return
      }

      captureDownloadTerminal('cancelled', state.modelId, {
        downloadType: (state as unknown as { downloadType?: string })
          ?.downloadType,
        totalBytes: state.size?.total,
      })
      clearPausedDownload(state.modelId)
      clearResumeParams(state.modelId)
      removeDownload(state.modelId)
      removeLocalDownloadingModel(state.modelId)
      clearDownloadOrigin(state.modelId)
      toast.dismiss('download-failed')

      markResumableDownload(state.modelId)
      if (wasDownloadCancellationRequested(state.modelId)) {
        toast.info(t('common:toast.downloadCancelled.title'), {
          id: 'cancel-download',
          description: t('common:toast.downloadCancelled.description'),
        })
        clearDownloadCancellationRequested(state.modelId)
      }
    },
    [
      removeDownload,
      removeLocalDownloadingModel,
      markResumableDownload,
      clearPausedDownload,
      clearResumeParams,
      clearDownloadOrigin,
      t,
    ]
  )

  const onFileDownloadSuccess = useCallback(
    async (state: DownloadState) => {
      console.debug('onFileDownloadSuccess', state)

      captureDownloadTerminal('completed', state.modelId, {
        downloadType: (state as unknown as { downloadType?: string })
          ?.downloadType,
        totalBytes: state.size?.total,
      })

      // Dismiss any validation started toast when download completes successfully
      toast.dismiss(`model-validation-started-${state.modelId}`)

      clearDownloadCancellationRequested(state.modelId)
      clearResumableDownload(state.modelId)
      clearPausedDownload(state.modelId)
      clearResumeParams(state.modelId)
      removeDownload(state.modelId)
      removeLocalDownloadingModel(state.modelId)
      clearDownloadOrigin(state.modelId)
      const diffusionKind = diffusionDownloadKind(state.modelId)
      toast.success(
        diffusionKind
          ? t(
              diffusionKind === 'model'
                ? 'images:download.modelReady'
                : 'images:download.engineReady'
            )
          : t('common:toast.downloadComplete.title'),
        {
        id: 'download-complete',
          description: diffusionKind
            ? undefined
            : t('common:toast.downloadComplete.description', {
                item: state.modelId,
              }),
        }
      )
    },
    [
      removeDownload,
      removeLocalDownloadingModel,
      clearResumableDownload,
      clearPausedDownload,
      clearResumeParams,
      clearDownloadOrigin,
      t,
    ]
  )

  const onFileDownloadAndVerificationSuccess = useCallback(
    async (state: DownloadState) => {
      console.debug('onFileDownloadAndVerificationSuccess', state)

      captureDownloadTerminal('completed', state.modelId, {
        downloadType: (state as unknown as { downloadType?: string })
          ?.downloadType,
        totalBytes: state.size?.total,
      })

      // Dismiss any validation started toast when download and verification complete successfully
      toast.dismiss(`model-validation-started-${state.modelId}`)

      clearDownloadCancellationRequested(state.modelId)
      clearResumableDownload(state.modelId)
      clearPausedDownload(state.modelId)
      clearResumeParams(state.modelId)
      removeDownload(state.modelId)
      removeLocalDownloadingModel(state.modelId)
      clearDownloadOrigin(state.modelId)
      const diffusionKind = diffusionDownloadKind(state.modelId)
      toast.success(
        diffusionKind
          ? t(
              diffusionKind === 'model'
                ? 'images:download.modelReady'
                : 'images:download.engineReady'
            )
          : t('common:toast.downloadAndVerificationComplete.title'),
        {
        id: 'download-complete',
          description: diffusionKind
            ? undefined
            : t(
                'common:toast.downloadAndVerificationComplete.description',
                {
                  item: state.modelId,
                }
              ),
        }
      )
    },
    [
      removeDownload,
      removeLocalDownloadingModel,
      clearResumableDownload,
      clearPausedDownload,
      clearResumeParams,
      clearDownloadOrigin,
      t,
    ]
  )

  useEffect(() => {
    console.debug('DownloadListener: registering event listeners...')
    events.on(DownloadEvent.onFileDownloadUpdate, onFileDownloadUpdate)
    events.on(DownloadEvent.onFileDownloadError, onFileDownloadError)
    events.on(DownloadEvent.onFileDownloadSuccess, onFileDownloadSuccess)
    events.on(DownloadEvent.onFileDownloadStopped, onFileDownloadStopped)
    events.on(DownloadEvent.onModelValidationStarted, onModelValidationStarted)
    events.on(DownloadEvent.onModelValidationFailed, onModelValidationFailed)
    events.on(
      DownloadEvent.onFileDownloadAndVerificationSuccess,
      onFileDownloadAndVerificationSuccess
    )

    // Register app update event listeners
    events.on(AppEvent.onAppUpdateDownloadUpdate, onAppUpdateDownloadUpdate)
    events.on(AppEvent.onAppUpdateDownloadSuccess, onAppUpdateDownloadSuccess)
    events.on(AppEvent.onAppUpdateDownloadError, onAppUpdateDownloadError)

    return () => {
      console.debug('DownloadListener: unregistering event listeners...')
      events.off(DownloadEvent.onFileDownloadUpdate, onFileDownloadUpdate)
      events.off(DownloadEvent.onFileDownloadError, onFileDownloadError)
      events.off(DownloadEvent.onFileDownloadSuccess, onFileDownloadSuccess)
      events.off(DownloadEvent.onFileDownloadStopped, onFileDownloadStopped)
      events.off(
        DownloadEvent.onModelValidationStarted,
        onModelValidationStarted
      )
      events.off(DownloadEvent.onModelValidationFailed, onModelValidationFailed)
      events.off(
        DownloadEvent.onFileDownloadAndVerificationSuccess,
        onFileDownloadAndVerificationSuccess
      )

      // Unregister app update event listeners
      events.off(AppEvent.onAppUpdateDownloadUpdate, onAppUpdateDownloadUpdate)
      events.off(
        AppEvent.onAppUpdateDownloadSuccess,
        onAppUpdateDownloadSuccess
      )
      events.off(AppEvent.onAppUpdateDownloadError, onAppUpdateDownloadError)
    }
  }, [
    onFileDownloadUpdate,
    onFileDownloadError,
    onFileDownloadSuccess,
    onFileDownloadStopped,
    onModelValidationStarted,
    onModelValidationFailed,
    onFileDownloadAndVerificationSuccess,
    onAppUpdateDownloadUpdate,
    onAppUpdateDownloadSuccess,
    onAppUpdateDownloadError,
  ])

  // ATO-154: pause/resume is only offered for resumable model (GGUF) downloads.
  // Backend-binary downloads (`llamacpp*`) and MLX repos (`mlx-community/*`,
  // which start with `mlx`) get cancel-only, matching Jan's gating.
  const isPausableDownload = (id: string): boolean =>
    !id.startsWith('llamacpp') && !id.startsWith('mlx')

  const handlePauseDownload = useCallback(
    (download: { id: string; name: string }) => {
      markPausedDownload(download.id)
      markResumableDownload(download.id)
      if (download.id !== download.name) {
        markPausedDownload(download.name)
        markResumableDownload(download.name)
      }
      if (isDiffusionModelDownloadTaskId(download.id)) {
        void cancelTransfer(download.id)
      } else {
        void serviceHub.models().abortDownload(download.name)
      }
    },
    [markPausedDownload, markResumableDownload, serviceHub]
  )

  const handleResumeDownload = useCallback(
    (download: { id: string; name: string }) => {
      const diffusionTarget = imageCatalog
        ? resolveDiffusionDownloadTaskId(imageCatalog, download.id)
        : null
      if (diffusionTarget) {
        clearPausedDownload(download.id)
        if (download.id !== download.name) clearPausedDownload(download.name)
        markResumableDownload(download.id)
        toast.success(t('common:toast.downloadResumed.title'), {
          icon: (
            <IconCheck
              size={16}
              className="text-blue-500 dark:text-blue-400"
              aria-hidden
            />
          ),
          duration: 2500,
        })
        void downloadArtifact(
          diffusionTarget.family,
          diffusionTarget.quant.id,
          {
            resume: true,
            hfToken: huggingfaceToken,
            workflow: useImageForm.getState().workflow,
          }
        )
          // Nothing else re-lists the models folder for a resume started
          // here, so the finished model kept reading as "not downloaded".
          .then(() => useImageGenerationStore.getState().refreshModelFiles())
          .catch((error) => {
            // downloadArtifact emits the ordinary transfer-error event first;
            // that listener owns the existing user-facing failure path.
            console.error(
              '[DownloadManagement] diffusion resume failed:',
              error
            )
          })
        return
      }

      const params = resumeParams[download.id] ?? resumeParams[download.name]
      if (!params) {
        // No stored params (e.g. resumed after an app restart). Fall back to
        // cancel-style cleanup so the row doesn't get stuck in a paused state.
        clearPausedDownload(download.id)
        toast.error(t('common:toast.downloadFailed.title'), {
          description: t('common:toast.downloadFailed.description', {
            item: download.name,
          }),
        })
        return
      }
      clearPausedDownload(download.id)
      if (download.id !== download.name) clearPausedDownload(download.name)
      markResumableDownload(download.id)
      void serviceHub
        .models()
        .pullModelWithMetadata(
          download.id,
          params.modelPath,
          params.mmprojPath,
          params.hfToken,
          params.skipVerification ?? true,
          true
        )
        .catch((error) => {
          console.error('[DownloadManagement] resume failed:', error)
        })
    },
    [
      imageCatalog,
      huggingfaceToken,
      resumeParams,
      clearPausedDownload,
      markResumableDownload,
      serviceHub,
      t,
    ]
  )

  // Shared with the composer's reply widget, which offers the same Cancel on
  // the download it lists.
  const handleCancelDownload = useCallback(
    (download: { id: string; name: string }) =>
      cancelDownload(download, serviceHub),
    [serviceHub]
  )

  const panelItems = useMemo<DownloadRowProps[]>(() => {
    const rows: DownloadRowProps[] = []

    if (appUpdateState.isDownloading) {
      rows.push({
        id: 'app-update',
        name: t('common:downloadPanel.appUpdate'),
        progress: appUpdateState.downloadProgress,
        current: appUpdateState.downloadedBytes,
        total: appUpdateState.totalBytes,
        bytesPerSecond: appUpdateBps,
      })
    }

    for (const download of downloadProcesses) {
      rows.push({
        ...download,
        paused: pausedDownloads.has(download.id),
        pausable: isPausableDownload(download.id),
        onPause: () => handlePauseDownload(download),
        onResume: () => handleResumeDownload(download),
        onCancel: () => handleCancelDownload(download),
      })
    }

    return rows
  }, [
    appUpdateState,
    appUpdateBps,
    downloadProcesses,
    pausedDownloads,
    handlePauseDownload,
    handleResumeDownload,
    handleCancelDownload,
    t,
  ])

  return (
    <DownloadPanel
      items={panelItems}
      onCollapsedChange={onPanelCollapsedChange}
    />
  )
}
