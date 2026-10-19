import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useThreads } from '@/hooks/useThreads'

export type SidebarListGroup = 'pinned' | 'projects' | 'recents'

type SidebarListsState = {
  /**
   * The order of pinned chats. Whether a chat is pinned is the thread's own
   * `isFavorite` flag (stored with the thread); this list only remembers the
   * order the user dragged them into. Ids of chats that were unpinned or
   * deleted elsewhere are ignored when the list is read.
   */
  pinOrder: string[]
  collapsed: Record<SidebarListGroup, boolean>
  toggleGroup: (group: SidebarListGroup) => void
  setPinOrder: (ids: string[]) => void
  notePinned: (id: string) => void
  noteUnpinned: (id: string) => void
}

export const useSidebarLists = create<SidebarListsState>()(
  persist(
    (set) => ({
      pinOrder: [],
      collapsed: { pinned: false, projects: false, recents: false },
      toggleGroup: (group) =>
        set((state) => ({
          collapsed: { ...state.collapsed, [group]: !state.collapsed[group] },
        })),
      setPinOrder: (ids) => set({ pinOrder: ids }),
      // A new pin goes to the end of the list, and the group opens so the
      // user sees where the chat went.
      notePinned: (id) =>
        set((state) => ({
          pinOrder: [...state.pinOrder.filter((value) => value !== id), id],
          collapsed: { ...state.collapsed, pinned: false },
        })),
      noteUnpinned: (id) =>
        set((state) => ({
          pinOrder: state.pinOrder.filter((value) => value !== id),
        })),
    }),
    { name: 'atomic-sidebar-lists' }
  )
)

/** Pinned chats in the user's order; pins with no remembered place go last, newest first. */
export function orderPinnedThreads(
  threads: Thread[],
  pinOrder: string[]
): Thread[] {
  const rank = new Map(pinOrder.map((id, index) => [id, index]))
  return threads
    .filter((thread) => thread.isFavorite)
    .sort((a, b) => {
      const ra = rank.get(a.id)
      const rb = rank.get(b.id)
      if (ra !== undefined && rb !== undefined) return ra - rb
      if (ra !== undefined) return -1
      if (rb !== undefined) return 1
      return (b.updated || 0) - (a.updated || 0)
    })
}

/** Moves `activeId` to `overId`'s place within the order currently shown. */
export function movePinnedThread(
  shownIds: string[],
  activeId: string,
  overId: string
): string[] {
  const from = shownIds.indexOf(activeId)
  const to = shownIds.indexOf(overId)
  if (from < 0 || to < 0 || from === to) return shownIds
  const next = [...shownIds]
  next.splice(to, 0, next.splice(from, 1)[0])
  return next
}

/** Pins or unpins a chat: flips its `isFavorite` and keeps the order in step. */
export function togglePinnedThread(threadId: string) {
  const thread = useThreads.getState().threads[threadId]
  if (!thread) return
  const pinning = !thread.isFavorite
  useThreads.getState().toggleFavorite(threadId)
  const lists = useSidebarLists.getState()
  if (pinning) lists.notePinned(threadId)
  else lists.noteUnpinned(threadId)
}
