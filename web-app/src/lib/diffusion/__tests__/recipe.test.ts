import { describe, expect, it } from 'vitest'

import { exportFilename, restoreDraftFromRecipe } from '../recipe'
import { makeItem, makeRecipe } from './image-fixtures'

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
    expect(draft).not.toHaveProperty('initImagePath')
  })

  it('leaves the negative prompt collapsed when there was none', () => {
    const { draft } = restoreDraftFromRecipe(makeRecipe({ negativePrompt: null }))
    expect(draft.negativePrompt).toBe('')
    expect(draft.negativeOpen).toBe(false)
  })
})
