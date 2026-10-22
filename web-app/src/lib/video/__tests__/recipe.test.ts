import { describe, expect, it } from 'vitest'

import {
  makeVideoItem,
  makeVideoRecipe,
} from '@/lib/diffusion/__tests__/video-fixtures'
import { useVideoForm } from '@/hooks/useVideoForm'
import type { VideoRecipe } from '@/services/diffusion/types'
import {
  exportVideoFilename,
  restoreVideoDraftFromRecipe,
  videoRecipeSettings,
} from '../recipe'

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
    const { draft } = restoreVideoDraftFromRecipe(
      makeVideoRecipe({ negativePrompt: null })
    )
    expect(draft.negativePrompt).toBe('')
    expect(draft.negativeOpen).toBe(false)
    expect(draft.guidance).toBeNull()
  })
})

describe('videoRecipeSettings', () => {
  const remoteEngine: VideoRecipe['engine'] = {
    kind: 'remote',
    provider: 'gemini',
    api: 'gemini-veo',
  }

  it('keeps every number a local engine recorded, zeros included', () => {
    expect(
      videoRecipeSettings(makeVideoRecipe({ steps: 8, cfgScale: 0, seed: 0 }))
    ).toEqual({ steps: 8, cfgScale: 0, seed: 0 })
  })

  it('never shows a provider clip the form numbers it was not sent, nor seed -1', () => {
    expect(
      videoRecipeSettings(
        makeVideoRecipe({
          engine: remoteEngine,
          steps: 8,
          cfgScale: 1,
          seed: -1,
        })
      )
    ).toEqual({ seed: undefined })
  })

  it('keeps a seed a provider was sent, zero included', () => {
    expect(
      videoRecipeSettings(makeVideoRecipe({ engine: remoteEngine, seed: 0 }))
    ).toEqual({ seed: 0 })
  })
})

describe("a provider's clip", () => {
  const engine: VideoRecipe['engine'] = {
    kind: 'remote',
    provider: 'gemini',
    api: 'gemini-veo',
  }
  const placeholders = makeVideoRecipe({
    engine,
    steps: 8,
    cfgScale: 1,
    seed: -1,
  })
  const { steps: _steps, cfgScale: _cfg, seed: _seed, ...unsent } = placeholders

  it.each([
    ['the old placeholders', placeholders],
    ['the knobs left out', unsent as VideoRecipe],
  ])(
    'restores no steps, CFG or seed from %s, so the form keeps its own',
    (_label, recipe) => {
      const { draft } = restoreVideoDraftFromRecipe(recipe)
      expect(draft).not.toHaveProperty('steps')
      expect(draft).not.toHaveProperty('cfgScale')
      expect(draft).not.toHaveProperty('seedText')
      expect(draft).toMatchObject({
        prompt: 'a lighthouse at dusk, waves rolling in',
      })
    }
  )

  it('keeps the form’s steps, CFG and seed when the draft is applied', () => {
    useVideoForm.setState({ steps: 12, cfgScale: 3, seedText: '77' })
    useVideoForm
      .getState()
      .applyDraft(restoreVideoDraftFromRecipe(placeholders).draft)
    expect(useVideoForm.getState()).toMatchObject({
      prompt: 'a lighthouse at dusk, waves rolling in',
      steps: 12,
      cfgScale: 3,
      seedText: '77',
    })
  })

  it('restores the seed it was sent, zero included', () => {
    const { draft } = restoreVideoDraftFromRecipe(
      makeVideoRecipe({ engine, seed: 0 })
    )
    expect(draft.seedText).toBe('0')
    expect(draft).not.toHaveProperty('steps')
  })

  it('names the export without a seed it does not have', () => {
    const createdAtMs = new Date(2026, 8, 23, 14, 30, 5).getTime()
    for (const recipe of [placeholders, unsent as VideoRecipe]) {
      const item = makeVideoItem({
        path: '/data/videos/vjob-1.mp4',
        recipe: { ...recipe, createdAtMs },
      })
      expect(exportVideoFilename(item)).toBe('AtomicChat_20260923-143005.mp4')
    }
  })
})
