import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { localStorageKey } from '@/constants/localStorage'
import { useImageSetting } from '@/hooks/useImageSetting'
import type { DiffusionModality } from '@/services/diffusion/types'

/**
 * The Video page's own choices. Everything about the engine and the resident
 * model's lifetime (engine override, memory policy, idle unload, evicting the
 * chat model, setup completion) lives in `useImageSetting`: there is one
 * engine and one resident diffusion model, whichever page loaded it.
 */
type VideoSettingState = {
  /** `<family>:<quantId>` of the video checkpoint the form generates with. */
  selectedArtifactId: string | null
  setSelectedArtifactId: (value: string | null) => void

  /** The Advanced section of the Video form is unfolded. */
  advancedOpen: boolean
  setAdvancedOpen: (value: boolean) => void

  /**
   * The video gallery folder the user chose, or null for `<data>/videos`.
   * Sent to the core on every configure, like the image folder.
   */
  outputDir: string | null
  setOutputDir: (value: string | null) => void
}

export const useVideoSetting = create<VideoSettingState>()(
  persist(
    (set) => ({
      selectedArtifactId: null,
      setSelectedArtifactId: (value) => set({ selectedArtifactId: value }),

      advancedOpen: false,
      setAdvancedOpen: (value) => set({ advancedOpen: value }),

      outputDir: null,
      setOutputDir: (value) => {
        const trimmed = value?.trim() ?? ''
        set({ outputDir: trimmed === '' ? null : trimmed })
      },
    }),
    {
      name: localStorageKey.settingVideos,
      storage: createJSONStorage(() => localStorage),
      version: 1,
      /** A value from a build that spelled a field differently falls back to the default. */
      migrate: (persisted) => {
        const state = persisted as Partial<VideoSettingState> | undefined
        if (!state) return state
        const next = { ...state }
        if (
          typeof next.selectedArtifactId !== 'string' ||
          next.selectedArtifactId.trim() === ''
        ) {
          next.selectedArtifactId = null
        }
        if (typeof next.advancedOpen !== 'boolean') next.advancedOpen = false
        if (
          typeof next.outputDir !== 'string' ||
          next.outputDir.trim() === ''
        ) {
          next.outputDir = null
        }
        return next
      },
    }
  )
)

/**
 * The selected checkpoint of one modality: the image pick from
 * `useImageSetting`, the video pick from `useVideoSetting`. Both stores are
 * read so the hook order never changes; only the asked-for one is returned.
 */
export function useSelectedArtifact(modality: DiffusionModality): {
  selectedArtifactId: string | null
  setSelectedArtifactId: (value: string | null) => void
} {
  const image = useImageSetting((state) => state.selectedArtifactId)
  const setImage = useImageSetting((state) => state.setSelectedArtifactId)
  const video = useVideoSetting((state) => state.selectedArtifactId)
  const setVideo = useVideoSetting((state) => state.setSelectedArtifactId)
  return modality === 'video'
    ? { selectedArtifactId: video, setSelectedArtifactId: setVideo }
    : { selectedArtifactId: image, setSelectedArtifactId: setImage }
}
