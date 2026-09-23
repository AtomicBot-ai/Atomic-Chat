import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { localStorageKey } from '@/constants/localStorage'
import {
  makeVideoCapabilities,
  makeWanCapabilities,
} from '@/lib/diffusion/__tests__/video-fixtures'
import { DEFAULT_VIDEO_FORM, nearestPreset, useVideoForm } from '../useVideoForm'

describe('useVideoForm', () => {
  beforeEach(async () => {
    localStorage.clear()
    await useVideoForm.persist.rehydrate()
    useVideoForm.setState({ ...DEFAULT_VIDEO_FORM })
  })

  it('persists the durable choices but never the prompts', () => {
    useVideoForm.getState().patch({
      prompt: 'An unsent video prompt',
      negativePrompt: 'An unsent negative prompt',
      negativeOpen: true,
      width: 1216,
      height: 704,
      frames: 73,
      steps: 6,
      seedText: '42',
    })
    const stored = JSON.parse(
      localStorage.getItem(localStorageKey.videoForm) ?? '{}'
    )
    expect(localStorageKey.videoForm).toBe('video-form')
    expect(stored.state).toEqual({
      negativeOpen: true,
      width: 1216,
      height: 704,
      frames: 73,
      steps: 6,
      cfgScale: 1,
      guidance: null,
      seedText: '42',
    })
  })

  it('drops prompt text a stored state carries, and keeps the rest', async () => {
    localStorage.setItem(
      localStorageKey.videoForm,
      JSON.stringify({
        state: { prompt: 'old', negativePrompt: 'old', frames: 49, steps: 4 },
        version: 0,
      })
    )
    await useVideoForm.persist.rehydrate()
    expect(useVideoForm.getState()).toMatchObject({
      prompt: '',
      negativePrompt: '',
      frames: 49,
      steps: 4,
    })
    localStorage.setItem(
      localStorageKey.videoForm,
      JSON.stringify({ state: ['not', 'an', 'object'], version: 0 })
    )
    await useVideoForm.persist.rehydrate()
    expect(useVideoForm.getState().frames).toBe(49)
  })

  it('keeps prompt text when the Video route remounts in one session', () => {
    const first = renderHook(() => useVideoForm((state) => state.prompt))
    act(() => {
      useVideoForm.getState().patch({ prompt: 'Keep this between routes' })
    })
    first.unmount()
    const second = renderHook(() => useVideoForm((state) => state.prompt))
    expect(second.result.current).toBe('Keep this between routes')
  })

  it('resets the knobs to the loaded model, keeping the prompt', () => {
    useVideoForm.getState().patch({
      prompt: 'kept',
      width: 704,
      height: 1216,
      frames: 25,
      steps: 3,
      cfgScale: 4,
      guidance: 2,
      seedText: '7',
    })
    useVideoForm.getState().resetToDefaults(makeWanCapabilities())
    expect(useVideoForm.getState()).toMatchObject({
      prompt: 'kept',
      width: 1280,
      height: 704,
      frames: 121,
      steps: 30,
      cfgScale: 5,
      guidance: null,
      seedText: '',
    })
    useVideoForm.getState().resetToDefaults(
      makeVideoCapabilities({
        supportsGuidance: true,
        defaults: { ...makeVideoCapabilities().defaults, guidance: 3 },
      })
    )
    expect(useVideoForm.getState().guidance).toBe(3)
  })

  it('applies a whole draft', () => {
    useVideoForm.getState().applyDraft({
      ...DEFAULT_VIDEO_FORM,
      prompt: 'from a recipe',
      frames: 49,
      seedText: '123',
    })
    expect(useVideoForm.getState()).toMatchObject({
      prompt: 'from a recipe',
      frames: 49,
      seedText: '123',
    })
  })

  it('clamps a draft left over from another family to the loaded one', () => {
    // LTX's 704x1216 portrait on Wan: its nearest portrait preset is 704x1280.
    useVideoForm.getState().patch({
      width: 704,
      height: 1216,
      frames: 73,
      steps: 200,
      guidance: 2,
    })
    useVideoForm.getState().clampTo(makeWanCapabilities())
    expect(useVideoForm.getState()).toMatchObject({
      width: 704,
      height: 1280,
      frames: 73,
      steps: 100,
      guidance: null,
    })
    // Wan's 1280x704 on LTX: nearest landscape preset 1216x704; 73 stays on 8k+1; 0 steps -> 1.
    useVideoForm.getState().patch({ width: 1280, height: 704, frames: 75, steps: 0 })
    useVideoForm.getState().clampTo(makeVideoCapabilities())
    expect(useVideoForm.getState()).toMatchObject({
      width: 1216,
      height: 704,
      frames: 73,
      steps: 1,
    })
    // A size that is already a preset is left alone; guidance is kept when supported.
    useVideoForm.getState().patch({ width: 512, height: 768, guidance: 2.5 })
    useVideoForm.getState().clampTo(makeVideoCapabilities({ supportsGuidance: true }))
    expect(useVideoForm.getState()).toMatchObject({
      width: 512,
      height: 768,
      guidance: 2.5,
    })
    useVideoForm.getState().patch({ guidance: null })
    useVideoForm.getState().clampTo(
      makeVideoCapabilities({
        supportsGuidance: true,
        defaults: { ...makeVideoCapabilities().defaults, guidance: 3 },
      })
    )
    expect(useVideoForm.getState().guidance).toBe(3)
  })
})

describe('nearestPreset', () => {
  const presets: [number, number][] = [
    [768, 512],
    [1216, 704],
    [704, 1216],
    [512, 768],
  ]

  it('prefers the same orientation, then the closest pixel count', () => {
    expect(nearestPreset(1280, 704, presets)).toEqual([1216, 704])
    expect(nearestPreset(704, 1280, presets)).toEqual([704, 1216])
    expect(nearestPreset(600, 600, presets)).toEqual([768, 512])
    expect(nearestPreset(300, 900, presets)).toEqual([512, 768])
    expect(nearestPreset(1, 1, [])).toBeNull()
    expect(nearestPreset(100, 300, [[1024, 1024]])).toEqual([1024, 1024])
  })
})
