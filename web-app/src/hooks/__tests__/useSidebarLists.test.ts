import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  movePinnedThread,
  orderPinnedThreads,
  togglePinnedThread,
  useSidebarLists,
} from '../useSidebarLists'
import { useThreads } from '../useThreads'

vi.mock('../useThreads', () => {
  const state = {
    threads: {} as Record<string, Thread>,
    toggleFavorite: vi.fn((id: string) => {
      const thread = state.threads[id]
      state.threads = {
        ...state.threads,
        [id]: { ...thread, isFavorite: !thread.isFavorite },
      }
    }),
  }
  return { useThreads: { getState: () => state } }
})

const thread = (id: string, extra: Partial<Thread> = {}): Thread =>
  ({ id, title: id, updated: 0, ...extra }) as Thread

describe('orderPinnedThreads', () => {
  it('keeps only pinned chats, in the remembered order', () => {
    const threads = [
      thread('a', { isFavorite: true }),
      thread('b'),
      thread('c', { isFavorite: true }),
    ]
    expect(orderPinnedThreads(threads, ['c', 'a']).map((t) => t.id)).toEqual([
      'c',
      'a',
    ])
  })

  it('puts pins with no remembered place last, newest first', () => {
    const threads = [
      thread('old', { isFavorite: true, updated: 1 }),
      thread('new', { isFavorite: true, updated: 5 }),
      thread('ranked', { isFavorite: true, updated: 0 }),
    ]
    expect(orderPinnedThreads(threads, ['ranked']).map((t) => t.id)).toEqual(
      ['ranked', 'new', 'old']
    )
  })

  it('ignores remembered ids of chats that are gone or unpinned', () => {
    const threads = [thread('a', { isFavorite: true }), thread('b')]
    expect(
      orderPinnedThreads(threads, ['deleted', 'b', 'a']).map((t) => t.id)
    ).toEqual(['a'])
  })
})

describe('movePinnedThread', () => {
  it('moves a chat to the place it was dropped on', () => {
    expect(movePinnedThread(['a', 'b', 'c'], 'c', 'a')).toEqual([
      'c',
      'a',
      'b',
    ])
    expect(movePinnedThread(['a', 'b', 'c'], 'a', 'b')).toEqual([
      'b',
      'a',
      'c',
    ])
  })

  it('leaves the order alone for an unknown or same target', () => {
    const ids = ['a', 'b']
    expect(movePinnedThread(ids, 'a', 'a')).toBe(ids)
    expect(movePinnedThread(ids, 'a', 'x')).toBe(ids)
  })
})

describe('togglePinnedThread', () => {
  beforeEach(() => {
    const state = useThreads.getState() as unknown as {
      threads: Record<string, Thread>
    }
    state.threads = { a: thread('a'), b: thread('b', { isFavorite: true }) }
    useSidebarLists.setState({
      pinOrder: ['b'],
      collapsed: { pinned: true, projects: false, recents: false },
    })
  })

  it('pins through isFavorite, appends to the order and opens Pinned', () => {
    togglePinnedThread('a')

    expect(useThreads.getState().toggleFavorite).toHaveBeenCalledWith('a')
    expect(useSidebarLists.getState().pinOrder).toEqual(['b', 'a'])
    expect(useSidebarLists.getState().collapsed.pinned).toBe(false)
  })

  it('unpins through isFavorite and forgets the place', () => {
    togglePinnedThread('b')

    expect(useThreads.getState().toggleFavorite).toHaveBeenCalledWith('b')
    expect(useSidebarLists.getState().pinOrder).toEqual([])
  })

  it('does nothing for a chat that no longer exists', () => {
    togglePinnedThread('missing')

    expect(useThreads.getState().toggleFavorite).not.toHaveBeenCalledWith(
      'missing'
    )
    expect(useSidebarLists.getState().pinOrder).toEqual(['b'])
  })
})

describe('collapsed groups', () => {
  it('toggles one group without touching the others', () => {
    useSidebarLists.setState({
      collapsed: { pinned: false, projects: false, recents: false },
    })
    useSidebarLists.getState().toggleGroup('recents')

    expect(useSidebarLists.getState().collapsed).toEqual({
      pinned: false,
      projects: false,
      recents: true,
    })
  })
})
