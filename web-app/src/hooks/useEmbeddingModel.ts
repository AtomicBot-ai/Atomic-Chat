import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { EMBEDDING_ENGINE } from '@/lib/embedding/engine'
import {
  activateEmbeddingModel,
  activateLocalEmbeddingModel,
  deleteEmbeddingModel,
  downloadEmbeddingModel,
  embeddingDownloadTaskId,
  isActiveEmbeddingModel,
  isActiveLocalEmbeddingModel,
  readLocalEmbeddingModel,
  stopEmbeddingModel,
  type LocalEmbeddingModel,
} from '@/lib/embedding/models'
import {
  cancelDownload as cancelPanelDownload,
  isDownloadCancellationError,
} from '@/lib/downloadCancellation'
import { getModelDisplayName } from '@/lib/utils'
import {
  embeddingDiskBytes,
  type EmbeddingCatalogModel,
} from '@/services/embedding-catalog-registry'
import type { EmbeddingState } from '@/services/embedding/types'
import { toEmbeddingError, useEmbeddingStore } from '@/stores/embedding-store'
import { raiseLocalApiServerForMediaModel } from '@/utils/localApiServerControl'

/** Start / stop of one model, whichever list it is in. */
export type EmbeddingRunState = {
  /** The core is configured to run this model. */
  active: boolean
  /** Active and switched on: the core runs it now or on the next request. */
  running: boolean
  /** The core's state while this model is running, else `null`. */
  state: EmbeddingState | null
  /** An activate / stop / remove of this model is in flight. */
  busy: boolean
  /** Start this model; `true` once it runs, `false` when it failed (the error is in the store). */
  activate: () => Promise<boolean>
  stop: () => Promise<boolean>
}

export type EmbeddingModelState = EmbeddingRunState & {
  installed: boolean
  downloading: boolean
  /** 0..1 */
  progress: number
  currentBytes: number
  totalBytes: number
  download: () => Promise<void>
  cancelDownload: () => void
  remove: () => Promise<boolean>
}

/**
 * Runs `action` as the one embedding call in flight for `busyKey`, keeping
 * the core's error, then re-reads the core's view.
 */
function useEmbeddingAction(busyKey: string) {
  return useCallback(
    /** `true` when `action` succeeded; a failure is kept in the store. */
    async (action: () => Promise<void>): Promise<boolean> => {
      const store = useEmbeddingStore.getState()
      store.setBusy(busyKey)
      try {
        await action()
        store.setError(null)
        return true
      } catch (error) {
        store.setError(toEmbeddingError(error))
        return false
      } finally {
        store.setBusy(null)
        await store.refresh()
      }
    },
    [busyKey]
  )
}

/** The run state shared by catalog and local models, from whether this one is configured. */
function useEmbeddingRunState(
  active: boolean,
  busyKey: string,
  start: () => Promise<unknown>
): EmbeddingRunState {
  const config = useEmbeddingStore((state) => state.config)
  const status = useEmbeddingStore((state) => state.status)
  const busyId = useEmbeddingStore((state) => state.busy)
  const run = useEmbeddingAction(busyKey)
  const running = active && Boolean(config?.enabled)

  const activate = useCallback(
    () =>
      run(async () => {
        await start()
        // Clients reach `/v1/embeddings` only through the Local API Server.
        void raiseLocalApiServerForMediaModel()
      }),
    [run, start]
  )

  const stop = useCallback(() => run(stopEmbeddingModel), [run])

  return {
    active,
    running,
    state: running ? (status?.state ?? null) : null,
    busy: busyId === busyKey,
    activate,
    stop,
  }
}

/**
 * Everything the settings card needs for one catalog embedding model.
 * Progress comes from `useDownloadStore` (the download panel's events), the
 * core's view from `useEmbeddingStore`, so the hook owns no state of its own.
 */
export function useEmbeddingModel(
  model: EmbeddingCatalogModel
): EmbeddingModelState {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const taskId = embeddingDownloadTaskId(model.id)

  const progressEntry = useDownloadStore((state) => state.downloads[taskId])
  const localDownloading = useDownloadStore((state) =>
    state.localDownloadingModels.has(taskId)
  )
  const huggingfaceToken = useGeneralSetting((state) => state.huggingfaceToken)

  const installed = useEmbeddingStore((state) =>
    Boolean(state.installed[model.id])
  )
  const config = useEmbeddingStore((state) => state.config)
  const downloading = localDownloading || Boolean(progressEntry)

  const start = useCallback(() => activateEmbeddingModel(model), [model])
  const runState = useEmbeddingRunState(
    isActiveEmbeddingModel(config, model),
    model.id,
    start
  )
  const run = useEmbeddingAction(model.id)

  const download = useCallback(async () => {
    const downloads = useDownloadStore.getState()
    const resume = downloads.resumableDownloads.has(taskId)
    downloads.clearResumableDownload(taskId)
    downloads.addLocalDownloadingModel(taskId)
    try {
      await downloadEmbeddingModel(model, {
        resume,
        ...(huggingfaceToken ? { hfToken: huggingfaceToken } : {}),
      })
    } catch (error) {
      // The panel already reported it (and a cancel is not a failure).
      if (!isDownloadCancellationError(error)) {
        console.error('[embedding] model download failed:', error)
      }
      useDownloadStore.getState().markResumableDownload(taskId)
    } finally {
      useDownloadStore.getState().removeLocalDownloadingModel(taskId)
      await useEmbeddingStore.getState().refreshInstalled()
    }
  }, [huggingfaceToken, model, taskId])

  const cancelDownload = useCallback(() => {
    cancelPanelDownload({ id: taskId, name: taskId }, serviceHub)
  }, [serviceHub, taskId])

  const remove = useCallback(
    () =>
      run(async () => {
        await deleteEmbeddingModel(model, useEmbeddingStore.getState().config)
        useDownloadStore.getState().clearResumableDownload(taskId)
        await useEmbeddingStore.getState().refreshInstalled()
        toast.success(t('settings:embedding.removed', { name: model.name }))
      }),
    [model, run, t, taskId]
  )

  return {
    ...runState,
    installed,
    downloading,
    progress: progressEntry?.progress ?? 0,
    currentBytes: progressEntry?.current ?? 0,
    totalBytes: progressEntry?.total || embeddingDiskBytes(model),
    download,
    cancelDownload,
    remove,
  }
}

/** Start / stop for an embedding GGUF the user has as a llama.cpp model. */
export function useLocalEmbeddingModel(
  model: LocalEmbeddingModel
): EmbeddingRunState {
  const config = useEmbeddingStore((state) => state.config)
  const start = useCallback(() => activateLocalEmbeddingModel(model), [model])
  // Kept apart from catalog ids: a llama.cpp model may carry the same name.
  return useEmbeddingRunState(
    isActiveLocalEmbeddingModel(config, model),
    `${EMBEDDING_ENGINE}:${model.id}`,
    start
  )
}

/**
 * The llama.cpp models the extension flagged as embedding GGUFs, with the
 * paths their `model.yml` names. A model whose weights are gone is left out.
 */
export function useLocalEmbeddingModels(): LocalEmbeddingModel[] {
  const models = useModelProvider(
    (state) =>
      state.providers.find((provider) => provider.provider === EMBEDDING_ENGINE)
        ?.models
  )
  const candidates = useMemo(
    () =>
      (models ?? [])
        .filter((model) => model.embedding === true && !model.missing)
        .map((model) => ({ id: model.id, name: getModelDisplayName(model) })),
    [models]
  )
  const [local, setLocal] = useState<LocalEmbeddingModel[]>([])

  useEffect(() => {
    let cancelled = false
    void Promise.all(
      candidates.map(({ id, name }) => readLocalEmbeddingModel(id, name))
    ).then((rows) => {
      if (cancelled) return
      setLocal(rows.filter((row): row is LocalEmbeddingModel => row !== null))
    })
    return () => {
      cancelled = true
    }
  }, [candidates])

  return local
}
