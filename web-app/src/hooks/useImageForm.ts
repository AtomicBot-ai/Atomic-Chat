import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { localStorageKey } from '@/constants/localStorage'
import { ALL_SIDES, type OutpaintSides } from '@/lib/diffusion/outpaint'
import type { ImageFormDraft } from '@/lib/diffusion/recipe'
import { matchAspect, snapDim, type DimConstraints } from '@/lib/diffusion/size'
import { MAX_EXTRA_REFERENCES } from '@/lib/diffusion/workflows'
import type {
  DiffusionFamilyDefaults,
  ImageCapabilities,
} from '@/services/diffusion/types'

export const MAX_IMAGE_RUNS = 20

/** A picked source image: where it is and how big, for the size maths. */
export type ImageSourceFile = {
  path: string
  width: number
  height: number
}

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

/**
 * The per-workflow knobs. Persisted like the rest of the draft: a strength
 * or an expand amount the user settled on is worth keeping across restarts.
 */
export type ImageWorkflowKnobs = {
  /** Transform / inpaint denoise strength, 0.1..1. */
  strength: number
  /** Inpaint brush, percent of the shorter image side, 2..25. */
  brushSize: number
  /** Extend: how much each chosen side adds, percent of the source, 10..100. */
  expandPercent: number
  sides: OutpaintSides
  /** Upscale: 1.5..4, capped at generation time by the model's ceiling. */
  upscaleFactor: number
  /** Upscale re-detail strength, 0.1..0.6. */
  upscaleStrength: number
}

export const DEFAULT_WORKFLOW_KNOBS: ImageWorkflowKnobs = {
  strength: 0.6,
  brushSize: 8,
  expandPercent: 25,
  sides: ALL_SIDES,
  upscaleFactor: 2,
  upscaleStrength: 0.35,
}

/**
 * The images a workflow works from. Never persisted: a path may be gone
 * after a restart, and a mask only makes sense over the picture it was
 * painted on.
 */
export type ImageWorkflowInputs = {
  sourceImage: ImageSourceFile | null
  /** The painted mask as a PNG data URL, white where the model repaints. */
  maskBase64: string | null
  /** Bumped to wipe the mask canvas. */
  maskResetKey: number
  /** Extra references after the source, `reference` only. */
  referenceImages: string[]
}

const EMPTY_INPUTS: ImageWorkflowInputs = {
  sourceImage: null,
  maskBase64: null,
  maskResetKey: 0,
  referenceImages: [],
}

type ImageFormState = ImageFormDraft &
  ImageWorkflowKnobs &
  ImageWorkflowInputs & {
    /** Merge a partial draft in; the one write path every control uses. */
    patch: (
      draft: Partial<ImageFormDraft & ImageWorkflowKnobs & ImageWorkflowInputs>
    ) => void
    /** Replace the whole draft, e.g. from a recipe. */
    applyDraft: (draft: ImageFormDraft) => void
    /** A new source: the mask painted over the old one is meaningless now. */
    setSourceImage: (source: ImageSourceFile | null) => void
    clearMask: () => void
    addReference: (path: string) => void
    removeReference: (index: number) => void
    /**
     * Reset the numeric parameters to the loaded model's defaults, keeping the
     * prompt: "start over with the knobs" is what Reset means, not "clear".
     */
    resetToDefaults: (defaults: DiffusionFamilyDefaults) => void
    /**
     * Clamp the draft to what the loaded model accepts. Called when a model
     * loads, so a size or step count left over from a different family cannot
     * be submitted. The workflow is the route's business, not this one's:
     * an unsupported workflow is reported at Generate, not silently swapped.
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
      ...DEFAULT_WORKFLOW_KNOBS,
      ...EMPTY_INPUTS,

      patch: (draft) => set(draft),

      applyDraft: (draft) => set({ ...draft }),

      setSourceImage: (source) =>
        set((state) => ({
          sourceImage: source,
          maskBase64: null,
          maskResetKey: state.maskResetKey + 1,
        })),

      clearMask: () =>
        set((state) => ({
          maskBase64: null,
          maskResetKey: state.maskResetKey + 1,
        })),

      addReference: (path) =>
        set((state) =>
          state.referenceImages.length >= MAX_EXTRA_REFERENCES
            ? {}
            : { referenceImages: [...state.referenceImages, path] }
        ),

      removeReference: (index) =>
        set((state) => ({
          referenceImages: state.referenceImages.filter((_, i) => i !== index),
        })),

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
          ...DEFAULT_WORKFLOW_KNOBS,
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
        strength: state.strength,
        brushSize: state.brushSize,
        expandPercent: state.expandPercent,
        sides: state.sides,
        upscaleFactor: state.upscaleFactor,
        upscaleStrength: state.upscaleStrength,
      }),
    }
  )
)
