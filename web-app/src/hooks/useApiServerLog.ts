import { create } from 'zustand'

import type {
  ApiLogEntry,
  ApiLogFilter,
  ApiRequestEntry,
  ApiRequestPatch,
} from '@/types/apiServerLog'
import { stripUndefined } from '@/utils/apiServerLogNormalize'

/**
 * In-memory log of Local API Server traffic.
 *
 * Deliberately NOT persisted: entries carry prompt and reply previews, which
 * must not outlive the session (see `types/apiServerLog.ts`). The Rust ring
 * buffer is the source of truth on mount; this store is the render model.
 */

export const MAX_LOG_ENTRIES = 500

export type BatchOp =
  | { t: 'start'; entry: ApiLogEntry }
  | { t: 'patch'; id: string; patch: ApiRequestPatch }

type ApiServerLogState = {
  /** Newest first. */
  entries: ApiLogEntry[]
  hydrated: boolean
  /** The backend has no inspector channel (older build, or web). */
  feedUnavailable: boolean
  selectedId: string | null
  filter: ApiLogFilter
  query: string
  droppedEvents: number

  applyBatch: (ops: BatchOp[]) => void
  hydrate: (entries: ApiLogEntry[], droppedEvents?: number) => void
  setFeedUnavailable: (value: boolean) => void
  clear: () => void
  select: (id: string | null) => void
  setFilter: (filter: ApiLogFilter) => void
  setQuery: (query: string) => void
  reset: () => void
}

const initial = {
  entries: [] as ApiLogEntry[],
  hydrated: false,
  feedUnavailable: false,
  selectedId: null as string | null,
  filter: 'all' as ApiLogFilter,
  query: '',
  droppedEvents: 0,
}

export const useApiServerLog = create<ApiServerLogState>()((set) => ({
  ...initial,

  applyBatch: (ops) =>
    set((state) => {
      if (ops.length === 0) return state
      let next = state.entries
      let copied = false
      const ensureCopy = () => {
        if (!copied) {
          next = next.slice()
          copied = true
        }
      }

      for (const op of ops) {
        if (op.t === 'start') {
          ensureCopy()
          next.unshift(op.entry)
          continue
        }
        // The row may have been evicted under a flood; its late patch is then
        // a no-op rather than resurrecting a partial entry.
        const index = next.findIndex((entry) => entry.id === op.id)
        if (index === -1) continue
        const existing = next[index]
        if (existing.kind !== 'request') continue
        ensureCopy()
        next[index] = {
          ...existing,
          ...stripUndefined(op.patch),
        } as ApiRequestEntry
      }

      if (!copied) return state
      if (next.length > MAX_LOG_ENTRIES) next.length = MAX_LOG_ENTRIES

      const selectionSurvives =
        state.selectedId !== null &&
        next.some((entry) => entry.id === state.selectedId)

      return {
        entries: next,
        // One-shot auto-select so the inspector isn't empty on first traffic.
        // After that the selection never follows the head — under load it
        // would flicker through every arriving request.
        selectedId:
          state.selectedId === null
            ? (next[0]?.id ?? null)
            : selectionSurvives
              ? state.selectedId
              : null,
      }
    }),

  hydrate: (entries, droppedEvents = 0) =>
    set((state) => ({
      entries: entries.slice(0, MAX_LOG_ENTRIES),
      hydrated: true,
      feedUnavailable: false,
      droppedEvents,
      selectedId:
        state.selectedId && entries.some((e) => e.id === state.selectedId)
          ? state.selectedId
          : (entries[0]?.id ?? null),
    })),

  setFeedUnavailable: (value) =>
    set({ feedUnavailable: value, hydrated: true }),
  clear: () => set({ entries: [], selectedId: null }),
  select: (selectedId) => set({ selectedId }),
  setFilter: (filter) => set({ filter }),
  setQuery: (query) => set({ query }),
  reset: () => set({ ...initial }),
}))

/** Rows matching the current filter and search query, newest first. */
export function filterEntries(
  entries: ApiLogEntry[],
  filter: ApiLogFilter,
  query: string
): ApiLogEntry[] {
  const needle = query.trim().toLowerCase()
  return entries.filter((entry) => {
    if (filter !== 'all') {
      if (entry.kind !== 'request') return false
      const wanted =
        filter === 'errors'
          ? 'error'
          : filter === 'in_flight'
            ? 'in_flight'
            : filter === 'completed'
              ? 'completed'
              : 'cancelled'
      if (entry.status !== wanted) return false
    }
    if (!needle) return true
    const haystack =
      entry.kind === 'request'
        ? [
            entry.endpoint,
            entry.model,
            entry.promptPreview,
            entry.replyPreview,
            entry.errorKind,
            entry.finishReason,
          ]
        : [entry.title, entry.detail]
    return haystack.some((value) => value?.toLowerCase().includes(needle))
  })
}
