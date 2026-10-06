import { useCallback } from 'react'
import { toast } from 'sonner'

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  activateDecisionModel,
  decisionDownloadTaskId,
  deleteDecisionModel,
  downloadDecisionModel,
  isActiveDecisionModel,
  stopDecisionModel,
} from '@/lib/decision/models'
import {
  cancelDownload as cancelPanelDownload,
  isDownloadCancellationError,
} from '@/lib/downloadCancellation'
import {
  decisionCheckpointBytes,
  type DecisionCatalogModel,
} from '@/services/decision-catalog-registry'
import type { DecisionState } from '@/services/decision/types'
import { toDecisionError, useDecisionStore } from '@/stores/decision-store'
import { raiseLocalApiServerForMediaModel } from '@/utils/localApiServerControl'

export type DecisionModelState = {
  installed: boolean
  downloading: boolean
  /** 0..1 */
  progress: number
  currentBytes: number
  totalBytes: number
  /** The core is configured to run this model. */
  active: boolean
  /** Active and switched on: the core runs it now or on the next call. */
  running: boolean
  /** The core's state while this model is running, else `null`. */
  state: DecisionState | null
  /** An activate / stop / remove of this model is in flight. */
  busy: boolean
  download: () => Promise<void>
  cancelDownload: () => void
  remove: () => Promise<void>
  activate: () => Promise<void>
  stop: () => Promise<void>
}

/**
 * Everything the settings card needs for one decision model. Progress comes
 * from `useDownloadStore` (the download panel's events), the core's view from
 * `useDecisionStore`, so the hook owns no state of its own.
 */
export function useDecisionModel(
  model: DecisionCatalogModel
): DecisionModelState {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const taskId = decisionDownloadTaskId(model.id)

  const progressEntry = useDownloadStore((state) => state.downloads[taskId])
  const localDownloading = useDownloadStore((state) =>
    state.localDownloadingModels.has(taskId)
  )
  const huggingfaceToken = useGeneralSetting((state) => state.huggingfaceToken)

  const installed = useDecisionStore((state) =>
    Boolean(state.installed[model.id])
  )
  const config = useDecisionStore((state) => state.config)
  const status = useDecisionStore((state) => state.status)
  const busyId = useDecisionStore((state) => state.busy)

  const active = isActiveDecisionModel(config, model)
  const running = active && Boolean(config?.enabled)
  const downloading = localDownloading || Boolean(progressEntry)

  const download = useCallback(async () => {
    const downloads = useDownloadStore.getState()
    const resume = downloads.resumableDownloads.has(taskId)
    downloads.clearResumableDownload(taskId)
    downloads.addLocalDownloadingModel(taskId)
    try {
      await downloadDecisionModel(model, {
        resume,
        ...(huggingfaceToken ? { hfToken: huggingfaceToken } : {}),
      })
    } catch (error) {
      // The panel already reported it (and a cancel is not a failure).
      if (!isDownloadCancellationError(error)) {
        console.error('[decision] model download failed:', error)
      }
      useDownloadStore.getState().markResumableDownload(taskId)
    } finally {
      useDownloadStore.getState().removeLocalDownloadingModel(taskId)
      await useDecisionStore.getState().refreshInstalled()
    }
  }, [huggingfaceToken, model, taskId])

  const cancelDownload = useCallback(() => {
    cancelPanelDownload({ id: taskId, name: taskId }, serviceHub)
  }, [serviceHub, taskId])

  const run = useCallback(
    async (action: () => Promise<void>) => {
      const store = useDecisionStore.getState()
      store.setBusy(model.id)
      try {
        await action()
        store.setError(null)
      } catch (error) {
        store.setError(toDecisionError(error))
      } finally {
        store.setBusy(null)
        await store.refresh()
      }
    },
    [model.id]
  )

  const activate = useCallback(
    () =>
      run(async () => {
        await activateDecisionModel(model)
        // Clients reach `/v1/systemone` only through the Local API Server.
        void raiseLocalApiServerForMediaModel()
      }),
    [model, run]
  )

  const stop = useCallback(() => run(stopDecisionModel), [run])

  const remove = useCallback(
    () =>
      run(async () => {
        await deleteDecisionModel(model, useDecisionStore.getState().config)
        useDownloadStore.getState().clearResumableDownload(taskId)
        await useDecisionStore.getState().refreshInstalled()
        toast.success(t('settings:decision.removed', { name: model.name }))
      }),
    [model, run, t, taskId]
  )

  return {
    installed,
    downloading,
    progress: progressEntry?.progress ?? 0,
    currentBytes: progressEntry?.current ?? 0,
    totalBytes: progressEntry?.total || decisionCheckpointBytes(model),
    active,
    running,
    state: running ? (status?.state ?? null) : null,
    busy: busyId === model.id,
    download,
    cancelDownload,
    remove,
    activate,
    stop,
  }
}
