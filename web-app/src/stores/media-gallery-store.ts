import { create, type StoreApi, type UseBoundStore } from 'zustand'

import type { GalleryListOptions } from '@/services/diffusion/types'

/** Items per page. Thumbnails and posters are 256 px, so a page is a few MB at most. */
export const PAGE_SIZE = 60

/** What the gallery needs of an item: an id, and the same shape across pages. */
export type MediaGalleryItem = { id: string }

export type MediaGalleryPage<T extends MediaGalleryItem> = {
  items: T[]
  hasMore: boolean
  total: number
}

export type MediaGalleryState<T extends MediaGalleryItem> = {
  items: T[]
  hasMore: boolean
  /** Total on disk, from the last listing — the grid's "N items" header. */
  total: number
  loading: boolean
  /** True once the first page has been requested, so an empty grid can say "nothing yet" instead of flashing. */
  initialized: boolean
  /** The item shown large in the viewer. */
  selectedId: string | null
  /** Multi-selection for delete; always contains `selectedId` when non-empty. */
  selectedIds: string[]
  /** Live follows the running job/latest output; gallery is a deliberate selection. */
  viewerMode: 'live' | 'gallery'
  selectLive: () => void

  /** Load the first page, replacing whatever is shown. */
  loadInitial: () => Promise<void>
  loadMore: () => Promise<void>
  /** Prepend outputs, selecting the first only when following live generation. */
  prepend: (items: T[]) => void
  /** Replace one item in place (a poster landed, a flag changed); unknown ids are ignored. */
  patch: (item: T) => void
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

export type MediaGalleryStoreOptions<T extends MediaGalleryItem> = {
  /** One page of the core's gallery, newest first. */
  list: (options: GalleryListOptions) => Promise<MediaGalleryPage<T>>
  /** `[images]` or `[videos]`, for the console. */
  logPrefix: string
}

export type MediaGalleryStore<T extends MediaGalleryItem> = UseBoundStore<
  StoreApi<MediaGalleryState<T>>
>

/**
 * A paged, selectable gallery over one of the core's galleries. The image and
 * the video gallery are instances of this with different item types; the
 * paging, the selection and the live/gallery viewer mode are the same.
 */
export function createMediaGalleryStore<T extends MediaGalleryItem>({
  list,
  logPrefix,
}: MediaGalleryStoreOptions<T>): MediaGalleryStore<T> {
  const initial = {
    items: [] as T[],
    hasMore: false,
    total: 0,
    loading: false,
    initialized: false,
    selectedId: null as string | null,
    selectedIds: [] as string[],
    viewerMode: 'live' as const,
  }

  return create<MediaGalleryState<T>>()((set, get) => ({
    ...initial,

    loadInitial: async () => {
      set({ loading: true })
      try {
        const page = await list({ offset: 0, limit: PAGE_SIZE })
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
        console.error(`${logPrefix} gallery listing failed:`, error)
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
        const page = await list({ offset: items.length, limit: PAGE_SIZE })
        const known = new Set(items.map((item) => item.id))
        set({
          items: [...items, ...page.items.filter((item) => !known.has(item.id))],
          hasMore: page.hasMore,
          total: page.total,
        })
      } catch (error) {
        console.error(`${logPrefix} gallery paging failed:`, error)
      } finally {
        set({ loading: false })
      }
    },

    prepend: (fresh) => {
      if (fresh.length === 0) return
      set((state) => {
        const incoming = new Set(fresh.map((item) => item.id))
        const rest = state.items.filter((item) => !incoming.has(item.id))
        const preserveSelection =
          state.viewerMode === 'gallery' &&
          state.items.some((item) => item.id === state.selectedId)
        return {
          items: [...fresh, ...rest],
          total: state.total + fresh.length - (state.items.length - rest.length),
          initialized: true,
          selectedId: preserveSelection ? state.selectedId : fresh[0].id,
          selectedIds: preserveSelection ? state.selectedIds : [fresh[0].id],
        }
      })
    },

    patch: (item) =>
      set((state) =>
        state.items.some((entry) => entry.id === item.id)
          ? {
              items: state.items.map((entry) =>
                entry.id === item.id ? item : entry
              ),
            }
          : {}
      ),

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

    selectLive: () => set({ viewerMode: 'live', selectedIds: [] }),

    select: (id) =>
      set({
        viewerMode: 'gallery',
        selectedId: id,
        selectedIds: id ? [id] : [],
      }),

    toggleSelect: (id, { shift, meta }) => {
      const { items, selectedId, selectedIds } = get()
      if (shift && selectedId) {
        const from = items.findIndex((item) => item.id === selectedId)
        const to = items.findIndex((item) => item.id === id)
        if (from >= 0 && to >= 0) {
          const [lo, hi] = from < to ? [from, to] : [to, from]
          const range = items.slice(lo, hi + 1).map((item) => item.id)
          set({
            viewerMode: 'gallery',
            selectedIds: [...new Set([...selectedIds, ...range])],
          })
          return
        }
      }
      if (meta) {
        const next = selectedIds.includes(id)
          ? selectedIds.filter((entry) => entry !== id)
          : [...selectedIds, id]
        set({
          viewerMode: 'gallery',
          selectedIds: next,
          selectedId: next.includes(selectedId ?? '') ? selectedId : (next[0] ?? null),
        })
        return
      }
      set({ viewerMode: 'gallery', selectedId: id, selectedIds: [id] })
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
      set({ viewerMode: 'gallery', selectedId: id, selectedIds: [id] })
    },

    reset: () => set({ ...initial }),
  }))
}
