/**
 * Where generated media is saved.
 *
 * Empty means the default, `<data folder>/media/outputs/`. A path means every
 * new generation is written there instead, under a readable file name. Only
 * the folder is remembered; the library index stays in the data folder so a
 * moved or unplugged output drive never takes the library with it.
 *
 * Persisted in `localStorage` because it is a UI preference, not library data.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type MediaOutputState = {
  folder: string
  setFolder: (folder: string) => void
  reset: () => void
}

export const useMediaOutputStore = create<MediaOutputState>()(
  persist(
    (set) => ({
      folder: '',
      setFolder: (folder) => set({ folder: folder.trim() }),
      reset: () => set({ folder: '' }),
    }),
    { name: 'radium-media-output' }
  )
)

/** Read outside React, e.g. by materialisation. */
export async function chosenMediaOutputFolder(): Promise<string | undefined> {
  return useMediaOutputStore.getState().folder || undefined
}
