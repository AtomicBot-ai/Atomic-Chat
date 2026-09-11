import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { localStorageKey } from '@/constants/localStorage'
import type { DiffusionEngineId } from '@/services/diffusion/types'

export type ImageEngineOverride = 'auto' | DiffusionEngineId

/** Whether loading an image model may evict the chat model from the GPU. */
export type ImageEvictPolicy = 'whenNeeded' | 'always'

export const IMAGE_IDLE_UNLOAD_OPTIONS = [0, 5, 10, 30, 60] as const
export const DEFAULT_IMAGE_IDLE_UNLOAD_MINUTES = 10

type ImageSettingState = {
  /** Set once the user finishes (or closes) the setup wizard. */
  setupCompleted: boolean
  setSetupCompleted: (value: boolean) => void

  /** `<family>:<quantId>` of the checkpoint the form generates with. */
  selectedArtifactId: string | null
  setSelectedArtifactId: (value: string | null) => void

  /** The Advanced section of the form (steps, cfg, seed, batch) is unfolded. */
  advancedOpen: boolean
  setAdvancedOpen: (value: boolean) => void

  /** Force an engine instead of letting the plugin pick. */
  engineOverride: ImageEngineOverride
  setEngineOverride: (value: ImageEngineOverride) => void

  /**
   * Keep the model resident after generating, ignoring the idle timer. Off by
   * default: a resident diffusion model is several GB the chat model cannot use.
   */
  keepModelLoaded: boolean
  setKeepModelLoaded: (value: boolean) => void

  /** Minutes without a job before the plugin unloads the model; 0 = never. */
  idleUnloadMinutes: number
  setIdleUnloadMinutes: (value: number) => void

  /**
   * `whenNeeded` unloads the chat model only when the image model would not
   * fit beside it; `always` frees the GPU before every load.
   */
  evictChatModel: ImageEvictPolicy
  setEvictChatModel: (value: ImageEvictPolicy) => void
}

const ENGINE_OVERRIDES: readonly ImageEngineOverride[] = [
  'auto',
  'sd-cpp',
  'diffusers',
]

export const useImageSetting = create<ImageSettingState>()(
  persist(
    (set) => ({
      setupCompleted: false,
      setSetupCompleted: (value) => set({ setupCompleted: value }),

      selectedArtifactId: null,
      setSelectedArtifactId: (value) => set({ selectedArtifactId: value }),

      advancedOpen: false,
      setAdvancedOpen: (value) => set({ advancedOpen: value }),

      engineOverride: 'auto',
      setEngineOverride: (value) => set({ engineOverride: value }),

      keepModelLoaded: false,
      setKeepModelLoaded: (value) => set({ keepModelLoaded: value }),

      idleUnloadMinutes: DEFAULT_IMAGE_IDLE_UNLOAD_MINUTES,
      setIdleUnloadMinutes: (value) =>
        set({ idleUnloadMinutes: Math.max(0, Math.floor(value)) }),

      evictChatModel: 'whenNeeded',
      setEvictChatModel: (value) => set({ evictChatModel: value }),
    }),
    {
      name: localStorageKey.settingImages,
      storage: createJSONStorage(() => localStorage),
      version: 1,
      /**
       * An engine we no longer offer, or a policy value from a build that
       * spelled it differently, would otherwise stay selected with no way to
       * clear it from the UI. Fall back to the defaults for those two fields
       * and keep everything else.
       */
      migrate: (persisted) => {
        const state = persisted as Partial<ImageSettingState> | undefined
        if (!state) return state
        const next = { ...state }
        if (
          next.engineOverride &&
          !ENGINE_OVERRIDES.includes(next.engineOverride)
        ) {
          next.engineOverride = 'auto'
        }
        if (
          next.evictChatModel !== 'whenNeeded' &&
          next.evictChatModel !== 'always'
        ) {
          next.evictChatModel = 'whenNeeded'
        }
        if (
          typeof next.idleUnloadMinutes !== 'number' ||
          !Number.isFinite(next.idleUnloadMinutes) ||
          next.idleUnloadMinutes < 0
        ) {
          next.idleUnloadMinutes = DEFAULT_IMAGE_IDLE_UNLOAD_MINUTES
        }
        return next
      },
    }
  )
)
