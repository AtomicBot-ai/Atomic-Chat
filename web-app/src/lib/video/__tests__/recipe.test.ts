import { describe, expect, it } from 'vitest'

import {
  makeVideoItem,
  makeVideoRecipe,
} from '@/lib/diffusion/__tests__/video-fixtures'
import { exportVideoFilename, restoreVideoDraftFromRecipe } from '../recipe'

describe('exportVideoFilename', () => {
  it('stamps local time and the seed', () => {
    const item = makeVideoItem({
      recipe: makeVideoRecipe({
        createdAtMs: new Date(2026, 8, 23, 14, 30, 5).getTime(),
        seed: 43,
      }),
    })
    expect(exportVideoFilename(item)).toBe('AtomicChat_20260923-143005_43.webm')
  })

  it('falls back to the file time when the recipe has none', () => {
    const item = makeVideoItem({
      createdAtMs: new Date(2026, 5, 1, 0, 0, 0).getTime(),
      recipe: makeVideoRecipe({ createdAtMs: 0, seed: 1 }),
    })
    expect(exportVideoFilename(item)).toBe('AtomicChat_20260601-000000_1.webm')
  })
})

describe('restoreVideoDraftFromRecipe', () => {
  it('carries the prompt, size, requested frames, knobs and seed across and names the model', () => {
    const { draft, modelId } = restoreVideoDraftFromRecipe(
      makeVideoRecipe({
        prompt: 'a red door',
        negativePrompt: 'blur',
        width: 1216,
        height: 704,
        frames: 121,
        frameCount: 117,
        steps: 12,
        cfgScale: 2.5,
        guidance: 3.5,
        seed: 99,
      })
    )
    expect(modelId).toBe('ltx-2:q4_k_m')
    expect(draft).toEqual({
      prompt: 'a red door',
      negativePrompt: 'blur',
      negativeOpen: true,
      width: 1216,
      height: 704,
      frames: 121,
      steps: 12,
      cfgScale: 2.5,
      guidance: 3.5,
      seedText: '99',
    })
  })

  it('leaves the negative prompt collapsed when there was none', () => {
    const { draft } = restoreVideoDraftFromRecipe(makeVideoRecipe({ negativePrompt: null }))
    expect(draft.negativePrompt).toBe('')
    expect(draft.negativeOpen).toBe(false)
    expect(draft.guidance).toBeNull()
  })
})
