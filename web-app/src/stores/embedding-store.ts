import { create } from 'zustand'

import { getServiceHub } from '@/hooks/useServiceHub'
import { isEmbeddingModelInstalled } from '@/lib/embedding/models'
import {
  fetchEmbeddingCatalog,
  getBaselineEmbeddingCatalog,
  type EmbeddingCatalog,
} from '@/services/embedding-catalog-registry'
import type {
  EmbeddingConfig,
  EmbeddingCoreError,
  EmbeddingStatus,
} from '@/services/embedding/types'

/** The relay's rejection, or anything else a call threw, as `{code, message}`. */
export function toEmbeddingError(error: unknown): EmbeddingCoreError {
  if (typeof error === 'object' && error !== null) {
    const { code, message, details } = error as Record<string, unknown>
    if (typeof code === 'string' && typeof message === 'string') {
      return {
        code,
        message,
        ...(typeof details === 'string' ? { details } : {}),
      }
    }
  }
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
  }
}

type EmbeddingStore = {
  catalog: EmbeddingCatalog
  status: EmbeddingStatus | null
  config: EmbeddingConfig | null
  /** Model id → every file of it is on disk. */
  installed: Record<string, boolean>
  /** The last failure of a call or an `embedding:error` event, cleared by the next success. */
  error: EmbeddingCoreError | null
  /** Model id with an activate / stop / remove in flight. */
  busy: string | null
  loadCatalog: (force?: boolean) => Promise<void>
  refresh: () => Promise<void>
  refreshInstalled: () => Promise<void>
  setStatus: (status: EmbeddingStatus) => void
  setConfig: (config: EmbeddingConfig) => void
  setError: (error: EmbeddingCoreError | null) => void
  setBusy: (id: string | null) => void
  /** Follow the core's events; returns the unsubscribe. */
  bind: () => () => void
}

export const useEmbeddingStore = create<EmbeddingStore>()((set, get) => ({
  catalog: getBaselineEmbeddingCatalog(),
  status: null,
  config: null,
  installed: {},
  error: null,
  busy: null,

  loadCatalog: async (force = false) => {
    const { catalog } = await fetchEmbeddingCatalog({ force })
    set({ catalog })
    await get().refreshInstalled()
  },

  refresh: async () => {
    const embedding = getServiceHub().embedding()
    if (!embedding.isSupported()) return
    try {
      const { config, status } = await embedding.getConfig()
      set({ config, status })
    } catch (error) {
      set({ error: toEmbeddingError(error) })
    }
  },

  refreshInstalled: async () => {
    const { catalog } = get()
    const entries = await Promise.all(
      catalog.models.map(
        async (model) =>
          [model.id, await isEmbeddingModelInstalled(model)] as const
      )
    )
    set({ installed: Object.fromEntries(entries) })
  },

  setStatus: (status) => set({ status }),
  setConfig: (config) => set({ config }),
  setError: (error) => set({ error }),
  setBusy: (busy) => set({ busy }),

  bind: () => {
    const embedding = getServiceHub().embedding()
    if (!embedding.isSupported()) return () => {}
    const unsubscribe = embedding.subscribe((event) => {
      if (event.type === 'state') {
        set({ status: event.status })
        if (event.status.state === 'ready') set({ error: null })
      } else if (event.type === 'error') {
        set({ error: event.error })
      } else {
        void get().refresh()
      }
    })
    void get().refresh()
    void get().loadCatalog()
    return unsubscribe
  },
}))
