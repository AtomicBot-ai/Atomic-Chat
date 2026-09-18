import { create } from 'zustand'

import { getServiceHub } from '@/hooks/useServiceHub'
import type { GalleryImageItem } from '@/services/diffusion/types'

/** Images per page. Thumbnails are 256 px WebP, so a page is a few MB at most. */
export const PAGE_SIZE = 60

type ImageGalleryState = {
  items: GalleryImageItem[]
  hasMore: boolean
  /** Total on disk, from the last listing — the grid's "N images" header. */
  total: number
  loading: boolean
  /** True once the first page has been requested, so an empty grid can say "no images yet" instead of flashing. */
  initialized: boolean
  /** The image shown large in the viewer. */
  selectedId: string | null
  /** Multi-selection for delete; always contains `selectedId` when non-empty. */
  selectedIds: string[]

  /** Load the first page, replacing whatever is shown. */
  loadInitial: () => Promise<void>
  loadMore: () => Promise<void>
  /** Put freshly generated images at the top and select the first one. */
  prepend: (items: GalleryImageItem[]) => void
  /** Drop items from the list (after a delete) and move the selection off them. */
  remove: (ids: string[]) => void
  select: (id: string | null) => void
  /**
   * Click with modifiers: shift extends the range from the anchor, meta/ctrl
   * toggles one tile. A plain click selects just that one.
   */
  toggleSelect: (id: string, modifiers: { shift: boolean; meta: boolean }) => void
  /** Move the single selection by `delta` tiles, staying inside the list. */
  step: (delta: number) => void
  reset: () => void
}

const initial = {
  items: [] as GalleryImageItem[],
  hasMore: false,
  total: 0,
  loading: false,
  initialized: false,
  selectedId: null as string | null,
  selectedIds: [] as string[],
}

export const useImageGalleryStore = create<ImageGalleryState>()((set, get) => ({
  ...initial,

  loadInitial: async () => {
    set({ loading: true })
    try {
      const page = await getServiceHub()
        .diffusion()
        .listGallery({ offset: 0, limit: PAGE_SIZE })
      const selectedId = get().selectedId
      const stillThere = page.items.some((item) => item.id === selectedId)
      set({
        items: page.items,
        hasMore: page.hasMore,
        total: page.total,
        initialized: true,
        selectedId: stillThere ? selectedId : (page.items[0]?.id ?? null),
        selectedIds: stillThere && selectedId ? [selectedId] : [],
      })
    } catch (error) {
      console.error('[images] gallery listing failed:', error)
      set({ initialized: true })
    } finally {
      set({ loading: false })
    }
  },

  loadMore: async () => {
    const { loading, hasMore, items } = get()
    if (loading || !hasMore) return
    set({ loading: true })
    try {
      const page = await getServiceHub()
        .diffusion()
        .listGallery({ offset: items.length, limit: PAGE_SIZE })
      const known = new Set(items.map((item) => item.id))
      set({
        items: [...items, ...page.items.filter((item) => !known.has(item.id))],
        hasMore: page.hasMore,
        total: page.total,
      })
    } catch (error) {
      console.error('[images] gallery paging failed:', error)
    } finally {
      set({ loading: false })
    }
  },

  prepend: (fresh) => {
    if (fresh.length === 0) return
    set((state) => {
      const incoming = new Set(fresh.map((item) => item.id))
      const rest = state.items.filter((item) => !incoming.has(item.id))
      return {
        items: [...fresh, ...rest],
        total: state.total + fresh.length - (state.items.length - rest.length),
        initialized: true,
        selectedId: fresh[0].id,
        selectedIds: [fresh[0].id],
      }
    })
  },

  remove: (ids) => {
    if (ids.length === 0) return
    set((state) => {
      const gone = new Set(ids)
      const firstRemoved = state.items.findIndex((item) => gone.has(item.id))
      const items = state.items.filter((item) => !gone.has(item.id))
      let selectedId = state.selectedId
      if (selectedId && gone.has(selectedId)) {
        // Land on the tile that took the deleted one's place, or the last one.
        const index = Math.min(Math.max(firstRemoved, 0), items.length - 1)
        selectedId = items[index]?.id ?? null
      }
      return {
        items,
        total: Math.max(0, state.total - (state.items.length - items.length)),
        selectedId,
        selectedIds: selectedId ? [selectedId] : [],
      }
    })
  },

  select: (id) => set({ selectedId: id, selectedIds: id ? [id] : [] }),

  toggleSelect: (id, { shift, meta }) => {
    const { items, selectedId, selectedIds } = get()
    if (shift && selectedId) {
      const from = items.findIndex((item) => item.id === selectedId)
      const to = items.findIndex((item) => item.id === id)
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from]
        const range = items.slice(lo, hi + 1).map((item) => item.id)
        set({ selectedIds: [...new Set([...selectedIds, ...range])] })
        return
      }
    }
    if (meta) {
      const next = selectedIds.includes(id)
        ? selectedIds.filter((entry) => entry !== id)
        : [...selectedIds, id]
      set({
        selectedIds: next,
        selectedId: next.includes(selectedId ?? '') ? selectedId : (next[0] ?? null),
      })
      return
    }
    set({ selectedId: id, selectedIds: [id] })
  },

  step: (delta) => {
    const { items, selectedId } = get()
    if (items.length === 0) return
    const current = items.findIndex((item) => item.id === selectedId)
    const next = Math.min(
      Math.max(current < 0 ? 0 : current + delta, 0),
      items.length - 1
    )
    const id = items[next].id
    set({ selectedId: id, selectedIds: [id] })
  },

  reset: () => set({ ...initial }),
}))
