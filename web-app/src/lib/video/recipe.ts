import type { VideoFormDraft } from '@/hooks/useVideoForm'
import type { GalleryVideoItem, VideoRecipe } from '@/services/diffusion/types'

export type RestoredVideoDraft = {
  draft: VideoFormDraft
  /** `<family>:<quantId>` the clip was made with, so the page can offer to load it. */
  modelId: string
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0')

/**
 * `AtomicChat_YYYYMMDD-HHMMSS_<seed>.webm` — the export name. Local time,
 * because the user is looking at the file next to their other downloads.
 */
export function exportVideoFilename(item: GalleryVideoItem): string {
  const { recipe } = item
  const date = new Date(recipe.createdAtMs || item.createdAtMs)
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `AtomicChat_${stamp}_${recipe.seed}.webm`
}

/**
 * Fill the form from a recipe: the prompt, the size, the frame count that
 * was requested (not the count the engine normalised to), the knobs and the
 * seed. The rate is the model's own and is not part of the draft.
 */
export function restoreVideoDraftFromRecipe(
  recipe: VideoRecipe
): RestoredVideoDraft {
  return {
    modelId: recipe.model.modelId,
    draft: {
      prompt: recipe.prompt,
      negativePrompt: recipe.negativePrompt ?? '',
      negativeOpen: Boolean(recipe.negativePrompt),
      width: recipe.width,
      height: recipe.height,
      frames: recipe.frames,
      steps: recipe.steps,
      cfgScale: recipe.cfgScale,
      guidance: recipe.guidance,
      seedText: String(recipe.seed),
    },
  }
}
