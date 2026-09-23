import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { localStorageKey } from '@/constants/localStorage'
import { snapFrames } from '@/lib/video/duration'
import type { VideoCapabilities } from '@/services/diffusion/types'

/** What the Video form holds; the numeric part is what a recipe restores. */
export type VideoFormDraft = {
  prompt: string
  negativePrompt: string
  negativeOpen: boolean
  width: number
  height: number
  frames: number
  steps: number
  cfgScale: number
  guidance: number | null
  /** The seed as typed. Empty means "let the engine pick one". */
  seedText: string
}

/** A sensible form before any video model has reported its defaults. */
export const DEFAULT_VIDEO_FORM: VideoFormDraft = {
  prompt: '',
  negativePrompt: '',
  negativeOpen: false,
  width: 768,
  height: 512,
  frames: 121,
  steps: 8,
  cfgScale: 1,
  guidance: null,
  seedText: '',
}

type VideoFormState = VideoFormDraft & {
  /** Merge a partial draft in; the one write path every control uses. */
  patch: (draft: Partial<VideoFormDraft>) => void
  /** Replace the whole draft, e.g. from a recipe. */
  applyDraft: (draft: VideoFormDraft) => void
  /**
   * Reset the numeric parameters to the loaded model's defaults, keeping the
   * prompt: "start over with the knobs" is what Reset means, not "clear".
   */
  resetToDefaults: (capabilities: VideoCapabilities) => void
  /**
   * Clamp the draft to what the loaded model accepts: the resolution to one
   * of its presets, the frame count to its lattice, the steps to its range.
   * Called when a model loads, so a choice left over from a different family
   * cannot be submitted.
   */
  clampTo: (capabilities: VideoCapabilities) => void
}

const clampInt = (value: number, lo: number, hi: number) =>
  Math.min(Math.max(Math.round(value), lo), hi)

/** The preset closest in pixel count and shape to the wanted size, or the first one. */
export function nearestPreset(
  width: number,
  height: number,
  presets: readonly [number, number][]
): [number, number] | null {
  let best: [number, number] | null = null
  let bestScore = Infinity
  for (const preset of presets) {
    const [w, h] = preset
    const sameOrientation = h > w === height > width || w === h || width === height
    const score = Math.abs(w * h - width * height) + (sameOrientation ? 0 : 1e12)
    if (score < bestScore) {
      best = preset
      bestScore = score
    }
  }
  return best
}

/**
 * v1 has never persisted prompt text; the guard is here so a later schema bump
 * cannot restore an old draft into a new app process either.
 */
const migrateVideoForm = (persistedState: unknown) => {
  if (
    !persistedState ||
    typeof persistedState !== 'object' ||
    Array.isArray(persistedState)
  ) {
    return {}
  }
  const next = { ...persistedState } as Record<string, unknown>
  delete next.prompt
  delete next.negativePrompt
  return next
}

export const useVideoForm = create<VideoFormState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_VIDEO_FORM,

      patch: (draft) => set(draft),

      applyDraft: (draft) => set({ ...draft }),

      resetToDefaults: (capabilities) => {
        const { defaults, frames } = capabilities
        set({
          width: defaults.width,
          height: defaults.height,
          frames: frames.default,
          steps: defaults.steps,
          cfgScale: defaults.cfgScale,
          guidance: defaults.guidance ?? null,
          seedText: '',
        })
      },

      clampTo: (capabilities) => {
        const state = get()
        const [minSteps, maxSteps] = capabilities.ranges.steps
        const preset = capabilities.resolutionPresets.some(
          ([w, h]) => w === state.width && h === state.height
        )
          ? null
          : nearestPreset(state.width, state.height, capabilities.resolutionPresets)
        set({
          ...(preset ? { width: preset[0], height: preset[1] } : {}),
          frames: snapFrames(state.frames, {
            fps: capabilities.fps,
            ...capabilities.frames,
          }),
          steps: clampInt(state.steps, minSteps, maxSteps),
          guidance: capabilities.supportsGuidance
            ? (state.guidance ?? capabilities.defaults.guidance ?? null)
            : null,
        })
      },
    }),
    {
      name: localStorageKey.videoForm,
      storage: createJSONStorage(() => localStorage),
      version: 1,
      migrate: migrateVideoForm,
      partialize: (state) => ({
        negativeOpen: state.negativeOpen,
        width: state.width,
        height: state.height,
        frames: state.frames,
        steps: state.steps,
        cfgScale: state.cfgScale,
        guidance: state.guidance,
        seedText: state.seedText,
      }),
    }
  )
)
