import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/shallow'

import type { GalleryImageItem } from '@/services/diffusion/types'
import { useImageGalleryStore } from '@/stores/image-gallery-store'

export type ImageGalleryHandle = {
  items: GalleryImageItem[]
  hasMore: boolean
  total: number
  loading: boolean
  initialized: boolean
  selected: GalleryImageItem | null
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
 * The gallery as the page sees it. Loads the first page on mount when nothing
 * is loaded yet; the store keeps the list across navigations so coming back
 * to the page is instant.
 */
export function useImageGallery(): ImageGalleryHandle {
  const state = useImageGalleryStore(
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
