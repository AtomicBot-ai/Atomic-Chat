import type { VideoFormDraft } from '@/hooks/useVideoForm'
import { recordedNumber, type RecipeSettings } from '@/lib/diffusion/recipe'
import {
  isRemoteRecipeEngine,
  type GalleryVideoItem,
  type VideoRecipe,
} from '@/services/diffusion/types'

/** The knobs a clip's recipe may not vouch for (`videoRecipeSettings`). */
type UnvouchedKnob = 'steps' | 'cfgScale' | 'seedText'

/**
 * A draft restored from a recipe: a knob the recipe cannot vouch for is left
 * out, so applying the draft keeps the form's own value for it.
 */
export type RestoredVideoFormDraft = Omit<VideoFormDraft, UnvouchedKnob> &
  Partial<Pick<VideoFormDraft, UnvouchedKnob>>

export type RestoredVideoDraft = {
  draft: RestoredVideoFormDraft
  /** `<family>:<quantId>` the clip was made with, so the page can offer to load it. */
  modelId: string
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0')

/** A clip's file extension: its own file's, which a provider's model makes as MP4. */
export function videoExtension(item: GalleryVideoItem): string {
  const match = /\.(mp4|webm)$/i.exec(item.path)
  return match ? match[1].toLowerCase() : (item.recipe.outputFormat ?? 'webm')
}

/**
 * `AtomicChat_YYYYMMDD-HHMMSS[_<seed>].<webm|mp4>` — the export name. Local
 * time, because the user is looking at the file next to their other downloads.
 * The seed is left out when the recipe cannot vouch for one.
 */
export function exportVideoFilename(item: GalleryVideoItem): string {
  const { recipe } = item
  const date = new Date(recipe.createdAtMs || item.createdAtMs)
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  const { seed } = videoRecipeSettings(recipe)
  const seedPart = seed !== undefined ? `_${seed}` : ''
  return `AtomicChat_${stamp}${seedPart}.${videoExtension(item)}`
}

/**
 * The settings a clip was made with, as its Details show them. A local
 * engine's numbers are shown as recorded, a zero included. A provider's clip
 * is never sent steps or CFG — the core records the form's numbers anyway —
 * and its seed is -1 when the model takes none; neither is a setting. A field
 * a recipe leaves out is not provided either.
 */
export function videoRecipeSettings(recipe: VideoRecipe): RecipeSettings {
  if (!isRemoteRecipeEngine(recipe.engine)) {
    return {
      steps: recordedNumber(recipe.steps),
      cfgScale: recordedNumber(recipe.cfgScale),
      seed: recordedNumber(recipe.seed),
    }
  }
  const seed = recordedNumber(recipe.seed)
  return { seed: seed !== undefined && seed >= 0 ? seed : undefined }
}

/**
 * Fill the form from a recipe: the prompt, the size, the frame count that
 * was requested (not the count the engine normalised to), the knobs and the
 * seed. The rate is the model's own and is not part of the draft. A steps
 * count, CFG or seed the recipe cannot vouch for (a provider's clip) is left
 * out, so the form keeps its own.
 */
export function restoreVideoDraftFromRecipe(
  recipe: VideoRecipe
): RestoredVideoDraft {
  const settings = videoRecipeSettings(recipe)
  return {
    modelId: recipe.model.modelId,
    draft: {
      prompt: recipe.prompt,
      negativePrompt: recipe.negativePrompt ?? '',
      negativeOpen: Boolean(recipe.negativePrompt),
      width: recipe.width,
      height: recipe.height,
      frames: recipe.frames,
      ...(settings.steps !== undefined ? { steps: settings.steps } : {}),
      ...(settings.cfgScale !== undefined
        ? { cfgScale: settings.cfgScale }
        : {}),
      guidance: recipe.guidance,
      ...(settings.seed !== undefined
        ? { seedText: String(settings.seed) }
        : {}),
    },
  }
}
