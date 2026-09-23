import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/shallow'

import type {
  MediaGalleryItem,
  MediaGalleryStore,
} from '@/stores/media-gallery-store'

export type MediaGalleryHandle<T extends MediaGalleryItem> = {
  items: T[]
  hasMore: boolean
  total: number
  loading: boolean
  initialized: boolean
  selected: T | null
  selectedId: string | null
  selectedIds: string[]
  loadMore: () => Promise<void>
  reload: () => Promise<void>
  select: (id: string | null) => void
  toggleSelect: (id: string, modifiers: { shift: boolean; meta: boolean }) => void
  step: (delta: number) => void
  remove: (ids: string[]) => void
}

/**
 * A gallery as its page sees it. Loads the first page on mount when nothing
 * is loaded yet; the store keeps the list across navigations so coming back
 * to the page is instant.
 */
export function useMediaGallery<T extends MediaGalleryItem>(
  useStore: MediaGalleryStore<T>
): MediaGalleryHandle<T> {
  const state = useStore(
    useShallow((store) => ({
      items: store.items,
      hasMore: store.hasMore,
      total: store.total,
      loading: store.loading,
      initialized: store.initialized,
      selectedId: store.selectedId,
      selectedIds: store.selectedIds,
      loadInitial: store.loadInitial,
      loadMore: store.loadMore,
      select: store.select,
      toggleSelect: store.toggleSelect,
      step: store.step,
      remove: store.remove,
    }))
  )

  useEffect(() => {
    if (!state.initialized && !state.loading) void state.loadInitial()
    // Only on mount: the store owns "already loaded".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selected = useMemo(
    () => state.items.find((item) => item.id === state.selectedId) ?? null,
    [state.items, state.selectedId]
  )

  return {
    items: state.items,
    hasMore: state.hasMore,
    total: state.total,
    loading: state.loading,
    initialized: state.initialized,
    selected,
    selectedId: state.selectedId,
    selectedIds: state.selectedIds,
    loadMore: state.loadMore,
    reload: state.loadInitial,
    select: state.select,
    toggleSelect: state.toggleSelect,
    step: state.step,
    remove: state.remove,
  }
}
