import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useAppUpdater } from '@/hooks/useAppUpdater'
import { useServiceHub } from '@/hooks/useServiceHub'
import { DownloadEvent, DownloadState, events, AppEvent } from '@janhq/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { DownloadPanel } from '@/containers/downloads/DownloadPanel'
import type { DownloadRowProps } from '@/containers/downloads/DownloadProgressRow'
import { advanceSpeedSample, newSpeedSample } from '@/lib/downloadFormat'
import {
  clearDownloadCancellationRequested,
  markDownloadCancellationRequested,
  wasDownloadCancellationRequested,
} from '@/lib/downloadCancellation'
import { classifyDownloadFailure } from '@/lib/download-errors'

function isCancellationLikeError(error?: string): boolean {
  if (!error) return false
  return /abort|aborted|cancel|cancelled|canceled|stop|stopped|interrupt/i.test(
    error
  )
}

export function DownloadManagement() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const {
    downloads,
    updateProgress,
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
    const downloadsWithProgress = Object.values(downloads).map((download) => ({
      id: download.name,
      name: download.name,
      progress: download.progress,
      current: download.current,
      total: download.total,
      bytesPerSecond: download.speed?.bytesPerSecond ?? 0,
    }))

    // Add local downloading models that don't have progress data yet
    const localDownloadsWithoutProgress = Array.from(localDownloadingModels)
      .filter((modelId) => !downloads[modelId]) // Only include models not in downloads
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

  const onFileDownloadUpdate = useCallback(
    async (state: DownloadState) => {
      updateProgress(
        state.modelId,
        state.percent,
        state.modelId,
        state.size?.transferred,
        state.size?.total
      )
    },
    [updateProgress]
  )

  const onFileDownloadError = useCallback(
    (state: DownloadState) => {
      console.debug('onFileDownloadError', state)
      clearPausedDownload(state.modelId)
      clearResumeParams(state.modelId)
      removeDownload(state.modelId)
      removeLocalDownloadingModel(state.modelId)
      clearDownloadOrigin(state.modelId)

      const anyState = state as unknown as {
        error?: string
        downloadType?: string
      }
      const err = anyState?.error || ''

      const cancelled =
        wasDownloadCancellationRequested(state.modelId) ||
        isCancellationLikeError(err)

      if (cancelled) {
        markResumableDownload(state.modelId)
        toast.dismiss('download-failed')
        return
      }

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


      // Dismiss any validation started toast when download completes successfully
      toast.dismiss(`model-validation-started-${state.modelId}`)

      clearDownloadCancellationRequested(state.modelId)
      clearResumableDownload(state.modelId)
      clearPausedDownload(state.modelId)
      clearResumeParams(state.modelId)
      removeDownload(state.modelId)
      removeLocalDownloadingModel(state.modelId)
      clearDownloadOrigin(state.modelId)
      toast.success(t('common:toast.downloadComplete.title'), {
        id: 'download-complete',
        description: t('common:toast.downloadComplete.description', {
          item: state.modelId,
        }),
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

  const onFileDownloadAndVerificationSuccess = useCallback(
    async (state: DownloadState) => {
      console.debug('onFileDownloadAndVerificationSuccess', state)


      // Dismiss any validation started toast when download and verification complete successfully
      toast.dismiss(`model-validation-started-${state.modelId}`)

      clearDownloadCancellationRequested(state.modelId)
      clearResumableDownload(state.modelId)
      clearPausedDownload(state.modelId)
      clearResumeParams(state.modelId)
      removeDownload(state.modelId)
      removeLocalDownloadingModel(state.modelId)
      clearDownloadOrigin(state.modelId)
      toast.success(t('common:toast.downloadAndVerificationComplete.title'), {
        id: 'download-complete',
        description: t(
          'common:toast.downloadAndVerificationComplete.description',
          {
            item: state.modelId,
          }
        ),
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
      void serviceHub.models().abortDownload(download.name)
    },
    [markPausedDownload, markResumableDownload, serviceHub]
  )

  const handleResumeDownload = useCallback(
    (download: { id: string; name: string }) => {
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
    [resumeParams, clearPausedDownload, markResumableDownload, serviceHub, t]
  )

  const handleCancelDownload = useCallback(
    (download: { id: string; name: string }) => {
      markDownloadCancellationRequested(download.name)
      markResumableDownload(download.name)
      clearPausedDownload(download.name)
      clearResumeParams(download.name)
      if (download.id !== download.name) {
        markDownloadCancellationRequested(download.id)
        markResumableDownload(download.id)
        clearPausedDownload(download.id)
        clearResumeParams(download.id)
      }
      if (download.id.startsWith('llamacpp') || download.id.startsWith('mlx')) {
        const downloadManager = window.core.extensionManager.getByName(
          '@janhq/download-extension'
        )
        downloadManager.cancelDownload(download.id)
      } else {
        serviceHub.models().abortDownload(download.name)
      }
    },
    [markResumableDownload, clearPausedDownload, clearResumeParams, serviceHub]
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
    />
  )
}
