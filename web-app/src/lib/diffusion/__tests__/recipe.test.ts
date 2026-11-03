import { describe, expect, it } from 'vitest'

import { useImageForm } from '@/hooks/useImageForm'
import type { ImageRecipe } from '@/services/diffusion/types'
import {
  exportFilename,
  imageRecipeSettings,
  restoreDraftFromRecipe,
} from '../recipe'
import { makeItem, makeRecipe } from './image-fixtures'

const remoteEngine: ImageRecipe['engine'] = {
  kind: 'remote',
  provider: 'openrouter',
  api: 'openrouter-images',
}

describe('exportFilename', () => {
  it('stamps local time and the per-image seed, with the batch index for a batch', () => {
    const item = makeItem({
      recipe: makeRecipe({
        createdAtMs: new Date(2026, 8, 10, 14, 30, 5).getTime(),
        seed: 43,
        index: 1,
        batchSize: 2,
      }),
    })
    expect(exportFilename(item)).toBe('AtomicChat_20260910-143005_43_2.png')
  })

  it('omits the index for a single image', () => {
    const item = makeItem({
      recipe: makeRecipe({
        createdAtMs: new Date(2026, 0, 3, 9, 4, 7).getTime(),
        seed: 7,
        index: 0,
        batchSize: 1,
      }),
    })
    expect(exportFilename(item)).toBe('AtomicChat_20260103-090407_7.png')
  })

  it('falls back to the file time when the recipe has none', () => {
    const item = makeItem({
      createdAtMs: new Date(2026, 5, 1, 0, 0, 0).getTime(),
      recipe: makeRecipe({ createdAtMs: 0, seed: 1, batchSize: 1 }),
    })
    expect(exportFilename(item)).toBe('AtomicChat_20260601-000000_1.png')
  })
})

describe('restoreDraftFromRecipe', () => {
  it('restores the batch seed, not the derived per-image seed', () => {
    const { draft } = restoreDraftFromRecipe(
      makeRecipe({ seed: 43, batchSeed: 42, batchSize: 2, index: 1 })
    )
    expect(draft.seedText).toBe('42')
    expect(draft.batchSize).toBe(2)
  })

  it('carries the prompt, size and knobs across and names the model', () => {
    const { draft, modelId } = restoreDraftFromRecipe(
      makeRecipe({
        prompt: 'a red door',
        negativePrompt: 'blur',
        width: 768,
        height: 1024,
        steps: 12,
        cfgScale: 2.5,
        guidance: 3.5,
      }),
      4
    )
    expect(modelId).toBe('z-image:q4_k_m')
    expect(draft).toMatchObject({
      prompt: 'a red door',
      negativePrompt: 'blur',
      negativeOpen: true,
      width: 768,
      height: 1024,
      aspect: 'photo',
      portrait: true,
      steps: 12,
      cfgScale: 2.5,
      guidance: 3.5,
      runs: 4,
    })
  })

  it('never restores a transform from a source image path', () => {
    const { draft } = restoreDraftFromRecipe(
      makeRecipe({ workflow: 'transform', strength: 0.6 })
    )
    expect(draft.workflow).toBe('create')
    expect(draft).not.toHaveProperty('initImage')
    expect(draft).not.toHaveProperty('sourceImage')
  })

  it('leaves the negative prompt collapsed when there was none', () => {
    const { draft } = restoreDraftFromRecipe(
      makeRecipe({ negativePrompt: null })
    )
    expect(draft.negativePrompt).toBe('')
    expect(draft.negativeOpen).toBe(false)
  })
})

describe('imageRecipeSettings', () => {
  it('keeps every number a local engine recorded, zeros included', () => {
    expect(
      imageRecipeSettings(
        makeRecipe({ steps: 8, cfgScale: 0, seed: 0, batchSeed: 0 })
      )
    ).toEqual({ steps: 8, cfgScale: 0, seed: 0, batchSeed: 0 })
  })

  it('drops the placeholders the core records for knobs a provider was not sent', () => {
    const settings = imageRecipeSettings(
      makeRecipe({
        engine: remoteEngine,
        steps: 0,
        cfgScale: 0,
        seed: -1,
        batchSeed: -1,
      })
    )
    expect(settings).toEqual({
      steps: undefined,
      cfgScale: undefined,
      seed: undefined,
      batchSeed: undefined,
    })
  })

  it('keeps what a provider was sent, a zero seed included', () => {
    expect(
      imageRecipeSettings(
        makeRecipe({
          engine: remoteEngine,
          steps: 28,
          cfgScale: 4.5,
          seed: 0,
          batchSeed: 0,
        })
      )
    ).toEqual({ steps: 28, cfgScale: 4.5, seed: 0, batchSeed: 0 })
  })

  it('treats a field the recipe leaves out as not provided', () => {
    const recipe = { ...makeRecipe(), steps: undefined, seed: undefined }
    const settings = imageRecipeSettings(recipe as unknown as ImageRecipe)
    expect(settings.steps).toBeUndefined()
    expect(settings.seed).toBeUndefined()
    expect(settings.cfgScale).toBe(1)
  })
})

describe("a provider's picture", () => {
  const placeholders = makeRecipe({
    engine: remoteEngine,
    steps: 0,
    cfgScale: 0,
    seed: -1,
    batchSeed: -1,
  })
  const {
    steps: _steps,
    cfgScale: _cfg,
    seed: _seed,
    batchSeed: _batchSeed,
    ...unsent
  } = placeholders

  it.each([
    ['the old placeholders', placeholders],
    ['the knobs left out', unsent as ImageRecipe],
  ])(
    'restores no steps, CFG or seed from %s, so the form keeps its own',
    (_label, recipe) => {
      const { draft } = restoreDraftFromRecipe(recipe)
      expect(draft).not.toHaveProperty('steps')
      expect(draft).not.toHaveProperty('cfgScale')
      expect(draft).not.toHaveProperty('seedText')
      expect(draft).toMatchObject({
        prompt: 'a lighthouse at dusk',
        width: 1024,
      })
    }
  )

  it('keeps the form’s steps, CFG and seed when the draft is applied', () => {
    useImageForm.setState({ steps: 12, cfgScale: 3, seedText: '77' })
    useImageForm
      .getState()
      .applyDraft(restoreDraftFromRecipe(placeholders).draft)
    expect(useImageForm.getState()).toMatchObject({
      prompt: 'a lighthouse at dusk',
      steps: 12,
      cfgScale: 3,
      seedText: '77',
    })
  })

  it('restores the knobs it was sent, a zero seed included', () => {
    const { draft } = restoreDraftFromRecipe(
      makeRecipe({
        engine: remoteEngine,
        steps: 28,
        cfgScale: 4.5,
        seed: 1,
        batchSeed: 0,
      })
    )
    expect(draft).toMatchObject({ steps: 28, cfgScale: 4.5, seedText: '0' })
  })

  it('names the export without a seed it does not have', () => {
    const createdAtMs = new Date(2026, 8, 10, 14, 30, 5).getTime()
    for (const recipe of [placeholders, unsent as ImageRecipe]) {
      const item = makeItem({
        recipe: { ...recipe, createdAtMs, index: 1, batchSize: 2 },
      })
      expect(exportFilename(item)).toBe('AtomicChat_20260910-143005_2.png')
    }
    const single = makeItem({
      recipe: { ...placeholders, createdAtMs, batchSize: 1 },
    })
    expect(exportFilename(single)).toBe('AtomicChat_20260910-143005.png')
    const seeded = makeItem({
      recipe: makeRecipe({
        engine: remoteEngine,
        createdAtMs,
        seed: 0,
        batchSize: 1,
      }),
    })
    expect(exportFilename(seeded)).toBe('AtomicChat_20260910-143005_0.png')
  })
})
