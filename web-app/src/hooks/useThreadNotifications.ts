import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'

type ThreadNotificationsState = {
  enabledThreads: Record<string, boolean>
  // Pre-armed flag for the next thread that gets created from the "New Chat"
  // screen. Consumed (reset to false) as soon as a thread is born.
  pendingDefault: boolean
  // Global master switch. When false, no notifications fire regardless of
  // per-thread opt-ins.
  globallyEnabled: boolean

  toggle: (threadId: string) => void
  setEnabled: (threadId: string, enabled: boolean) => void
  isEnabled: (threadId: string) => boolean
  clearThread: (threadId: string) => void

  togglePendingDefault: () => void
  setPendingDefault: (value: boolean) => void
  consumePendingDefault: () => boolean

  setGloballyEnabled: (value: boolean) => void
}

export const useThreadNotifications = create<ThreadNotificationsState>()(
  persist(
    (set, get) => ({
      enabledThreads: {},
      pendingDefault: false,
      globallyEnabled: true,

      toggle: (threadId: string) => {
        set((state) => {
          const current = state.enabledThreads[threadId] === true
          const next = { ...state.enabledThreads }
          if (current) {
            delete next[threadId]
          } else {
            next[threadId] = true
          }
          return { enabledThreads: next }
        })
      },

      setEnabled: (threadId: string, enabled: boolean) => {
        set((state) => {
          const next = { ...state.enabledThreads }
          if (enabled) {
            next[threadId] = true
          } else {
            delete next[threadId]
          }
          return { enabledThreads: next }
        })
      },

      isEnabled: (threadId: string) => {
        return get().enabledThreads[threadId] === true
      },

      clearThread: (threadId: string) => {
        set((state) => {
          if (state.enabledThreads[threadId] === undefined) return state
          const next = { ...state.enabledThreads }
          delete next[threadId]
          return { enabledThreads: next }
        })
      },

      togglePendingDefault: () => {
        set((state) => ({ pendingDefault: !state.pendingDefault }))
      },

      setPendingDefault: (value: boolean) => {
        set({ pendingDefault: value })
      },

      consumePendingDefault: () => {
        const value = get().pendingDefault
        if (value) set({ pendingDefault: false })
        return value
      },

      setGloballyEnabled: (value: boolean) => {
        set({ globallyEnabled: value })
      },
    }),
    {
      name: localStorageKey.threadNotifications,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        enabledThreads: state.enabledThreads,
        pendingDefault: state.pendingDefault,
        globallyEnabled: state.globallyEnabled,
      }),
    }
  )
)
