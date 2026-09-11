/**
 * Recipe helpers: turning a gallery item back into a form draft, and naming
 * the file when the user saves a copy.
 */

import type { GalleryImageItem, ImageRecipe } from '@/services/diffusion/types'
import { matchAspect, type AspectId } from './size'

/**
 * The part of the Images form a recipe can fill in. Everything that is a user
 * choice at generation time; nothing that is a runtime detail (engine, backend,
 * offload policy) — those are decided again at load time.
 */
export type ImageFormDraft = {
  prompt: string
  negativePrompt: string
  negativeOpen: boolean
  width: number
  height: number
  aspect: AspectId
  portrait: boolean
  steps: number
  cfgScale: number
  guidance: number | null
  /** The seed as typed. Empty means "let the engine pick one". */
  seedText: string
  batchSize: number
  runs: number
  workflow: 'create' | 'transform'
}

export type RestoredDraft = {
  draft: ImageFormDraft
  /** `<family>:<quantId>` the image was made with, so the page can offer to load it. */
  modelId: string
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0')

/**
 * `AtomicChat_YYYYMMDD-HHMMSS_<seed>[_n].png` — the export name.
 *
 * Local time, because the user is looking at the file next to their other
 * downloads. The batch index is only appended for a batch bigger than one, so
 * a single image keeps the shorter name.
 */
export function exportFilename(item: GalleryImageItem): string {
  const { recipe } = item
  const date = new Date(recipe.createdAtMs || item.createdAtMs)
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  const suffix = recipe.batchSize > 1 ? `_${recipe.index + 1}` : ''
  return `AtomicChat_${stamp}_${recipe.seed}${suffix}.png`
}

/**
 * Fill the form from a recipe.
 *
 * Restores `batchSeed` — the seed the batch was *requested* with — not the
 * per-image `seed` (`batchSeed + index`): re-running with the batch seed and
 * the same batch size reproduces the whole batch, image N included, whereas
 * restoring the derived seed would shift every image by `index`.
 *
 * Never restores `initImagePath`: the source image may be gone, and a transform
 * is never silently re-run from a path the user did not just pick. The draft
 * comes back as a `create` workflow with the same prompt and settings.
 */
export function restoreDraftFromRecipe(
  recipe: ImageRecipe,
  runs = 1
): RestoredDraft {
  const width = recipe.width
  const height = recipe.height
  return {
    modelId: recipe.model.modelId,
    draft: {
      prompt: recipe.prompt,
      negativePrompt: recipe.negativePrompt ?? '',
      negativeOpen: Boolean(recipe.negativePrompt),
      width,
      height,
      aspect: matchAspect(width, height),
      portrait: height > width,
      steps: recipe.steps,
      cfgScale: recipe.cfgScale,
      guidance: recipe.guidance,
      seedText: String(recipe.batchSeed),
      batchSize: Math.max(1, recipe.batchSize),
      runs: Math.max(1, runs),
      workflow: 'create',
    },
  }
}
