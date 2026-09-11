import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { localStorageKey } from '@/constants/localStorage'
import type { ImageFormDraft } from '@/lib/diffusion/recipe'
import { matchAspect, snapDim, type DimConstraints } from '@/lib/diffusion/size'
import type {
  DiffusionFamilyDefaults,
  ImageCapabilities,
} from '@/services/diffusion/types'

export const MAX_IMAGE_RUNS = 20

/** A sensible form before any model has reported its defaults. */
export const DEFAULT_IMAGE_FORM: ImageFormDraft = {
  prompt: '',
  negativePrompt: '',
  negativeOpen: false,
  width: 1024,
  height: 1024,
  aspect: 'square',
  portrait: false,
  steps: 20,
  cfgScale: 1,
  guidance: null,
  seedText: '',
  batchSize: 1,
  runs: 1,
  workflow: 'create',
}

type ImageFormState = ImageFormDraft & {
  /** Merge a partial draft in; the one write path every control uses. */
  patch: (draft: Partial<ImageFormDraft>) => void
  /** Replace the whole draft, e.g. from a recipe. */
  applyDraft: (draft: ImageFormDraft) => void
  /**
   * Reset the numeric parameters to the loaded model's defaults, keeping the
   * prompt: "start over with the knobs" is what Reset means, not "clear".
   */
  resetToDefaults: (defaults: DiffusionFamilyDefaults) => void
  /**
   * Clamp the draft to what the loaded model accepts. Called when a model
   * loads, so a size or step count left over from a different family cannot
   * be submitted.
   */
  clampTo: (capabilities: ImageCapabilities) => void
}

/** Parse the seed field. Empty or non-numeric means "engine picks". */
export function parseSeedText(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (!/^-?\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value < 0) return null
  return value
}

/** A fresh seed inside the range sd-server accepts (a signed 32-bit int). */
export function randomSeed(): number {
  const buffer = new Uint32Array(1)
  crypto.getRandomValues(buffer)
  return buffer[0] % 2_147_483_647
}

const clampInt = (value: number, lo: number, hi: number) =>
  Math.min(Math.max(Math.round(value), lo), hi)

export const useImageForm = create<ImageFormState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_IMAGE_FORM,

      patch: (draft) => set(draft),

      applyDraft: (draft) => set({ ...draft }),

      resetToDefaults: (defaults) => {
        const width = defaults.width
        const height = defaults.height
        set({
          width,
          height,
          aspect: matchAspect(width, height),
          portrait: height > width,
          steps: defaults.steps,
          cfgScale: defaults.cfgScale,
          guidance: defaults.guidance ?? null,
          seedText: '',
          batchSize: 1,
          runs: 1,
        })
      },

      clampTo: (capabilities) => {
        const state = get()
        const constraints: DimConstraints = {
          minDim: capabilities.minDim,
          maxDim: capabilities.maxDim,
          dimMultiple: capabilities.dimMultiple,
        }
        const [minSteps, maxSteps] = capabilities.ranges.steps
        const width = snapDim(state.width, constraints)
        const height = snapDim(state.height, constraints)
        set({
          width,
          height,
          aspect: matchAspect(width, height),
          steps: clampInt(state.steps, minSteps, maxSteps),
          batchSize: clampInt(state.batchSize, 1, Math.max(1, capabilities.maxBatch)),
          runs: clampInt(state.runs, 1, MAX_IMAGE_RUNS),
          guidance: capabilities.supportsGuidance
            ? (state.guidance ?? capabilities.defaults.guidance ?? null)
            : null,
          workflow: capabilities.workflows.includes(state.workflow)
            ? state.workflow
            : 'create',
        })
      },
    }),
    {
      name: localStorageKey.imageForm,
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (state) => ({
        prompt: state.prompt,
        negativePrompt: state.negativePrompt,
        negativeOpen: state.negativeOpen,
        width: state.width,
        height: state.height,
        aspect: state.aspect,
        portrait: state.portrait,
        steps: state.steps,
        cfgScale: state.cfgScale,
        guidance: state.guidance,
        seedText: state.seedText,
        batchSize: state.batchSize,
        runs: state.runs,
        workflow: state.workflow,
      }),
    }
  )
)
