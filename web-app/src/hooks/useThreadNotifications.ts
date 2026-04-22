import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'

type ThreadNotificationsState = {
  // Single global master switch for desktop notifications on reply completion.
  globallyEnabled: boolean
  setGloballyEnabled: (value: boolean) => void
}

export const useThreadNotifications = create<ThreadNotificationsState>()(
  persist(
    (set) => ({
      globallyEnabled: true,
      setGloballyEnabled: (value: boolean) => {
        set({ globallyEnabled: value })
      },
    }),
    {
      name: localStorageKey.threadNotifications,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        globallyEnabled: state.globallyEnabled,
      }),
    }
  )
)
