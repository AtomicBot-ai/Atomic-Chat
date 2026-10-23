/**
 * Recipe helpers: turning a gallery item back into a form draft, and naming
 * the file when the user saves a copy.
 */

import {
  isRemoteRecipeEngine,
  type GalleryImageItem,
  type ImageRecipe,
  type ImageWorkflowId,
} from '@/services/diffusion/types'
import { matchAspect, type AspectId } from './size'

/**
 * The generation knobs a picture's or clip's Details can vouch for. A field
 * that is absent was not provided, and its row is not shown.
 */
export type RecipeSettings = {
  steps?: number
  cfgScale?: number
  seed?: number
  /** Images only: the seed the batch was requested with. */
  batchSeed?: number
}

/** A recorded number, or undefined for a field a recipe leaves out. */
export const recordedNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** A recorded number when `provided` accepts it, else undefined. */
const recordedIf = (
  value: unknown,
  provided: (value: number) => boolean
): number | undefined => {
  const recorded = recordedNumber(value)
  return recorded !== undefined && provided(recorded) ? recorded : undefined
}

/**
 * The settings a picture was made with, as its Details show them.
 *
 * A local engine records every knob it ran with, a zero included, so its
 * numbers are shown as recorded. A provider's model is sent only the knobs
 * it takes, and the core records the rest as placeholders — steps and CFG 0,
 * seed and batch seed -1 — which are not settings: a step count or CFG the
 * core sends is above zero, and a seed it sends or draws is zero or more.
 * Those placeholders, and any field a recipe leaves out, are not provided.
 */
export function imageRecipeSettings(recipe: ImageRecipe): RecipeSettings {
  if (!isRemoteRecipeEngine(recipe.engine)) {
    return {
      steps: recordedNumber(recipe.steps),
      cfgScale: recordedNumber(recipe.cfgScale),
      seed: recordedNumber(recipe.seed),
      batchSeed: recordedNumber(recipe.batchSeed),
    }
  }
  return {
    steps: recordedIf(recipe.steps, (steps) => steps > 0),
    cfgScale: recordedIf(recipe.cfgScale, (cfg) => cfg > 0),
    seed: recordedIf(recipe.seed, (seed) => seed >= 0),
    batchSeed: recordedIf(recipe.batchSeed, (seed) => seed >= 0),
  }
}

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
  workflow: ImageWorkflowId
}

/** The knobs a recipe may not vouch for (`imageRecipeSettings`). */
type UnvouchedKnob = 'steps' | 'cfgScale' | 'seedText'

/**
 * A draft restored from a recipe: a knob the recipe cannot vouch for is left
 * out, so applying the draft keeps the form's own value for it.
 */
export type RestoredImageFormDraft = Omit<ImageFormDraft, UnvouchedKnob> &
  Partial<Pick<ImageFormDraft, UnvouchedKnob>>

export type RestoredDraft = {
  draft: RestoredImageFormDraft
  /** `<family>:<quantId>` the image was made with, so the page can offer to load it. */
  modelId: string
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0')

/** A picture's file extension: its own file's, which a provider's model may make as JPEG or WebP. */
export function imageExtension(item: GalleryImageItem): string {
  const match = /\.(png|jpe?g|webp)$/i.exec(item.path)
  return match ? match[1].toLowerCase() : 'png'
}

/**
 * `AtomicChat_YYYYMMDD-HHMMSS[_<seed>][_n].<png|jpg|webp>` — the export name.
 *
 * Local time, because the user is looking at the file next to their other
 * downloads. The seed is left out when the recipe cannot vouch for one (a
 * provider's model that takes none). The batch index is only appended for a
 * batch bigger than one, so a single image keeps the shorter name.
 */
export function exportFilename(item: GalleryImageItem): string {
  const { recipe } = item
  const date = new Date(recipe.createdAtMs || item.createdAtMs)
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  const { seed } = imageRecipeSettings(recipe)
  const seedPart = seed !== undefined ? `_${seed}` : ''
  const suffix = recipe.batchSize > 1 ? `_${recipe.index + 1}` : ''
  return `AtomicChat_${stamp}${seedPart}${suffix}.${imageExtension(item)}`
}

/**
 * Fill the form from a recipe.
 *
 * Restores `batchSeed` — the seed the batch was *requested* with — not the
 * per-image `seed` (`batchSeed + index`): re-running with the batch seed and
 * the same batch size reproduces the whole batch, image N included, whereas
 * restoring the derived seed would shift every image by `index`.
 *
 * Never restores the source, mask or reference images: they may be gone, and
 * an image workflow is never silently re-run from inputs the user did not
 * just pick. The draft comes back as a `create` workflow with the same
 * prompt and settings.
 *
 * A steps count, CFG or seed the recipe cannot vouch for (a provider's model
 * was not sent it) is left out of the draft, so the form keeps its own.
 */
export function restoreDraftFromRecipe(
  recipe: ImageRecipe,
  runs = 1
): RestoredDraft {
  const width = recipe.width
  const height = recipe.height
  const settings = imageRecipeSettings(recipe)
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
      ...(settings.steps !== undefined ? { steps: settings.steps } : {}),
      ...(settings.cfgScale !== undefined
        ? { cfgScale: settings.cfgScale }
        : {}),
      guidance: recipe.guidance,
      ...(settings.batchSeed !== undefined
        ? { seedText: String(settings.batchSeed) }
        : {}),
      batchSize: Math.max(1, recipe.batchSize),
      runs: Math.max(1, runs),
      workflow: 'create',
    },
  }
}
