import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

import { localStorageKey } from '@/constants/localStorage'
import type { CompactionEvent } from '@/lib/context-compaction'

/**
 * Recorded auto-compaction events per thread. The chat transport records an
 * event when it replaces older messages with a model-written summary; the
 * thread view renders a marker at the boundary message so the user can see
 * where the summarized history begins and expand the summary.
 *
 * Events are keyed by the UI message id of the first message kept verbatim,
 * so a marker renders only while that message still exists (deleting or
 * regenerating past the boundary retires the marker naturally).
 */

const MAX_MARKERS_PER_THREAD = 20

interface CompactionMarkerState {
  markersByThread: Record<string, CompactionEvent[]>
  recordMarker: (threadId: string, event: CompactionEvent) => void
}

export const useCompactionMarkers = create<CompactionMarkerState>()(
  persist(
    (set) => ({
      markersByThread: {},
      recordMarker: (threadId, event) =>
        set((state) => {
          const existing = state.markersByThread[threadId] ?? []
          const next = [
            ...existing.filter(
              (marker) => marker.boundaryMessageId !== event.boundaryMessageId
            ),
            event,
          ].slice(-MAX_MARKERS_PER_THREAD)
          return {
            markersByThread: {
              ...state.markersByThread,
              [threadId]: next,
            },
          }
        }),
    }),
    {
      name: localStorageKey.compactionMarkers,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ markersByThread: state.markersByThread }),
    }
  )
)
