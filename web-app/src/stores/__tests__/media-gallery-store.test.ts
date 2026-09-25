import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeItem } from '@/lib/diffusion/__tests__/image-fixtures'
import { makeVideoItem } from '@/lib/diffusion/__tests__/video-fixtures'
import type { GalleryImageItem, GalleryVideoItem } from '@/services/diffusion/types'
import { createMediaGalleryStore, PAGE_SIZE } from '../media-gallery-store'

const ids = (n: number, prefix = 'item') =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(2, '0')}`)

describe('createMediaGalleryStore', () => {
  const backing: { items: GalleryImageItem[] } = { items: [] }
  const list = vi.fn(async ({ offset, limit }: { offset: number; limit: number }) => ({
    items: backing.items.slice(offset, offset + limit),
    hasMore: offset + limit < backing.items.length,
    total: backing.items.length,
  }))
  const store = createMediaGalleryStore<GalleryImageItem>({
    list,
    logPrefix: '[test]',
  })

  beforeEach(() => {
    list.mockClear()
    backing.items = ids(70).map((id) => makeItem({ id }))
    store.getState().reset()
  })

  it('pages through the listing without doubling an item that moved between pages', async () => {
    await store.getState().loadInitial()
    expect(list).toHaveBeenCalledWith({ offset: 0, limit: PAGE_SIZE })
    expect(store.getState()).toMatchObject({
      hasMore: true,
      total: 70,
      initialized: true,
      loading: false,
      selectedId: 'item-00',
      selectedIds: [],
    })
    expect(store.getState().items).toHaveLength(PAGE_SIZE)

    // A clip landed at the top meanwhile: the next page overlaps by one.
    backing.items = [makeItem({ id: 'fresh' }), ...backing.items]
    await store.getState().loadMore()
    expect(list).toHaveBeenLastCalledWith({ offset: PAGE_SIZE, limit: PAGE_SIZE })
    expect(store.getState().items).toHaveLength(70)
    expect(new Set(store.getState().items.map((i) => i.id)).size).toBe(70)
    expect(store.getState().hasMore).toBe(false)
    await store.getState().loadMore()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('keeps a selection that survives a reload and drops one that does not', async () => {
    await store.getState().loadInitial()
    store.getState().select('item-05')
    await store.getState().loadInitial()
    expect(store.getState()).toMatchObject({
      selectedId: 'item-05',
      selectedIds: ['item-05'],
    })
    backing.items = backing.items.filter((item) => item.id !== 'item-05')
    await store.getState().loadInitial()
    expect(store.getState().selectedId).toBe('item-00')
  })

  it('reports a listing failure and still counts as initialized', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    list.mockRejectedValueOnce(new Error('offline'))
    await store.getState().loadInitial()
    expect(store.getState()).toMatchObject({ initialized: true, loading: false, items: [] })
    expect(error).toHaveBeenCalledWith('[test] gallery listing failed:', expect.any(Error))
    list.mockRejectedValueOnce(new Error('offline'))
    store.setState({ hasMore: true })
    await store.getState().loadMore()
    expect(error).toHaveBeenLastCalledWith('[test] gallery paging failed:', expect.any(Error))
    error.mockRestore()
  })

  it('prepends fresh outputs, following live unless the gallery is being browsed', () => {
    store.getState().prepend([makeItem({ id: 'a' }), makeItem({ id: 'b' })])
    expect(store.getState()).toMatchObject({
      total: 2,
      initialized: true,
      selectedId: 'a',
      selectedIds: ['a'],
    })
    store.getState().select('b')
    store.getState().prepend([makeItem({ id: 'c' }), makeItem({ id: 'a' })])
    expect(store.getState().items.map((i) => i.id)).toEqual(['c', 'a', 'b'])
    expect(store.getState()).toMatchObject({ total: 3, selectedId: 'b' })
    store.getState().prepend([])
    expect(store.getState().items).toHaveLength(3)
  })

  it('patches an item in place and ignores one it does not list', () => {
    store.getState().prepend([makeItem({ id: 'a', pinned: false })])
    store.getState().patch(makeItem({ id: 'a', pinned: true }))
    expect(store.getState().items[0].pinned).toBe(true)
    store.getState().patch(makeItem({ id: 'zzz' }))
    expect(store.getState().items).toHaveLength(1)
  })

  it('removes items and lands the selection on the neighbour', () => {
    store.getState().prepend(['a', 'b', 'c', 'd'].map((id) => makeItem({ id })))
    store.getState().select('b')
    store.getState().remove(['b', 'c'])
    expect(store.getState().items.map((i) => i.id)).toEqual(['a', 'd'])
    expect(store.getState()).toMatchObject({ total: 2, selectedId: 'd', selectedIds: ['d'] })
    store.getState().remove(['d'])
    expect(store.getState().selectedId).toBe('a')
    store.getState().remove(['a'])
    expect(store.getState()).toMatchObject({ selectedId: null, selectedIds: [], total: 0 })
    store.getState().remove([])
  })

  it('selects with shift and meta, steps inside the list, and returns to live', () => {
    store.getState().prepend(['a', 'b', 'c', 'd'].map((id) => makeItem({ id })))
    store.getState().toggleSelect('b', { shift: false, meta: false })
    store.getState().toggleSelect('d', { shift: true, meta: false })
    expect(store.getState().selectedIds).toEqual(['b', 'c', 'd'])
    expect(store.getState().viewerMode).toBe('gallery')
    store.getState().toggleSelect('c', { shift: false, meta: true })
    expect(store.getState().selectedIds).toEqual(['b', 'd'])
    expect(store.getState().selectedId).toBe('b')
    store.getState().toggleSelect('b', { shift: false, meta: true })
    expect(store.getState()).toMatchObject({ selectedIds: ['d'], selectedId: 'd' })
    store.getState().toggleSelect('a', { shift: false, meta: true })
    store.getState().toggleSelect('a', { shift: false, meta: true })
    store.getState().toggleSelect('d', { shift: false, meta: true })
    expect(store.getState()).toMatchObject({ selectedIds: [], selectedId: null })
    // Shift with an anchor that is gone falls back to a plain click.
    store.getState().toggleSelect('zzz', { shift: true, meta: false })
    expect(store.getState()).toMatchObject({ selectedIds: ['zzz'], selectedId: 'zzz' })

    store.getState().select('a')
    store.getState().step(2)
    expect(store.getState().selectedId).toBe('c')
    store.getState().step(5)
    expect(store.getState().selectedId).toBe('d')
    store.getState().step(-9)
    expect(store.getState().selectedId).toBe('a')
    store.setState({ selectedId: 'gone' })
    store.getState().step(1)
    expect(store.getState().selectedId).toBe('a')

    store.getState().selectLive()
    expect(store.getState()).toMatchObject({ viewerMode: 'live', selectedIds: [] })
    store.getState().select(null)
    expect(store.getState()).toMatchObject({ selectedId: null, selectedIds: [] })
    store.setState({ items: [] })
    store.getState().step(1)
    expect(store.getState().selectedId).toBeNull()
  })

  it('serves a video gallery with the same behaviour', async () => {
    const videos = createMediaGalleryStore<GalleryVideoItem>({
      list: async () => ({ items: [makeVideoItem({ id: 'v1' })], hasMore: false, total: 1 }),
      logPrefix: '[videos]',
    })
    await videos.getState().loadInitial()
    expect(videos.getState().items[0].recipe.frames).toBe(49)
    videos.getState().patch(makeVideoItem({ id: 'v1', posterPath: null }))
    expect(videos.getState().items[0].posterPath).toBeNull()
  })
})
