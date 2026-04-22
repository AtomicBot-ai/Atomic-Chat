import { localStorageKey } from '@/constants/localStorage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type LastSeenVersionState = {
  lastSeenVersion: string | null
  setLastSeenVersion: (version: string) => void
}

export const useLastSeenVersion = create<LastSeenVersionState>()(
  persist(
    (set) => ({
      lastSeenVersion: null,
      setLastSeenVersion: (version: string) =>
        set({ lastSeenVersion: version }),
    }),
    {
      name: localStorageKey.lastSeenVersion,
      storage: createJSONStorage(() => localStorage),
    }
  )
)
