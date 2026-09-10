import { create } from 'zustand'

type ThreadReadState = {
  unreadThreads: Record<string, true>
  markUnread: (threadId: string) => void
  markRead: (threadId: string) => void
  removeThread: (threadId: string) => void
  clearAll: () => void
}

export const useThreadReadStatus = create<ThreadReadState>((set) => ({
  unreadThreads: {},
  markUnread: (threadId) =>
    set((state) => ({
      unreadThreads: { ...state.unreadThreads, [threadId]: true },
    })),
  markRead: (threadId) =>
    set((state) => {
      if (!(threadId in state.unreadThreads)) {
        return state
      }
      const rest = { ...state.unreadThreads }
      delete rest[threadId]
      return { unreadThreads: rest }
    }),
  removeThread: (threadId) =>
    set((state) => {
      if (!(threadId in state.unreadThreads)) {
        return state
      }
      const rest = { ...state.unreadThreads }
      delete rest[threadId]
      return { unreadThreads: rest }
    }),
  clearAll: () => set({ unreadThreads: {} }),
}))
