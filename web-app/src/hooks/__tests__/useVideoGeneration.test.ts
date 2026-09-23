import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeFakeDiffusion,
  makeStatus,
} from '@/lib/diffusion/__tests__/image-fixtures'
import {
  makeVideoCapabilities,
  makeVideoLoadedStatus,
  makeWanCapabilities,
  LTX_Q4_ID,
} from '@/lib/diffusion/__tests__/video-fixtures'
import { seedServiceHub } from '@/test/service-hub'
import { DEFAULT_VIDEO_FORM, useVideoForm } from '@/hooks/useVideoForm'
import { useVideoSetting } from '@/hooks/useVideoSetting'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useVideoGenerationStore } from '@/stores/video-generation-store'
import { useVideoGeneration } from '../useVideoGeneration'

describe('useVideoGeneration', () => {
  beforeEach(() => {
    seedServiceHub({ diffusion: makeFakeDiffusion() })
    useImageGenerationStore.getState().reset()
    useVideoGenerationStore.getState().reset()
    useVideoForm.setState({ ...DEFAULT_VIDEO_FORM, prompt: 'a lighthouse' })
    useVideoSetting.setState({ selectedArtifactId: null })
    useImageGenerationStore.setState({
      status: makeVideoLoadedStatus(),
      videoCapabilities: makeVideoCapabilities(),
    })
  })

  it('builds the request from the form and the family, and can generate', () => {
    useVideoForm.setState({
      negativePrompt: 'blurry',
      width: 1216,
      height: 704,
      frames: 49,
      steps: 6,
      cfgScale: 1,
      guidance: 3,
      seedText: '7',
    })
    const { result } = renderHook(() => useVideoGeneration())
    expect(result.current).toMatchObject({
      modelReady: true,
      canGenerate: true,
      disabledReason: null,
      seed: 7,
      request: {
        prompt: 'a lighthouse',
        width: 1216,
        height: 704,
        frames: 49,
        fps: 24,
        steps: 6,
        cfgScale: 1,
        samplingMethod: 'euler',
        workflow: 'create',
      },
    })
    // LTX takes neither a negative prompt nor guidance; Wan takes a negative prompt and flow shift.
    expect(result.current.request).not.toHaveProperty('negativePrompt')
    expect(result.current.request).not.toHaveProperty('guidance')
    expect(result.current.request).not.toHaveProperty('flowShift')

    act(() => {
      useImageGenerationStore.setState({
        videoCapabilities: makeWanCapabilities({ supportsGuidance: true }),
      })
    })
    expect(result.current.request).toMatchObject({
      negativePrompt: 'blurry',
      guidance: 3,
      flowShift: 5,
    })
  })

  it.each([
    ['noEngine', () => useImageGenerationStore.setState({ status: makeStatus({ install: { state: 'not-installed' } }) })],
    ['modelLoading', () => useImageGenerationStore.setState({ loadingArtifactId: LTX_Q4_ID })],
    ['noModel', () => useImageGenerationStore.setState({ status: makeStatus(), videoCapabilities: null })],
    ['noModel', () => useVideoSetting.setState({ selectedArtifactId: 'wan2.2-ti2v-5b:q4_k_m' })],
    ['emptyPrompt', () => useVideoForm.setState({ prompt: '   ' })],
    ['busy', () => useVideoGenerationStore.setState({ generating: true })],
    ['busy', () => useImageGenerationStore.setState({ generating: true })],
  ] as const)('is disabled for %s', (reason, arrange) => {
    arrange()
    const { result } = renderHook(() => useVideoGeneration())
    expect(result.current.disabledReason).toBe(reason)
    expect(result.current.canGenerate).toBe(false)
  })

  it('is not ready while an image model is the resident one', () => {
    useImageGenerationStore.setState({
      status: makeStatus({
        model: {
          state: 'loaded',
          loaded: { ...makeVideoLoadedStatus().model.loaded!, modality: 'image' },
        },
      }),
    })
    const { result } = renderHook(() => useVideoGeneration())
    expect(result.current.modelReady).toBe(false)
    expect(result.current.disabledReason).toBe('noModel')
  })

  it('forwards generate and stop to the store, and generate does nothing while disabled', async () => {
    const start = vi.fn(async () => {})
    const stop = vi.fn(async () => {})
    useVideoGenerationStore.setState({ startGeneration: start, stop })
    const { result } = renderHook(() => useVideoGeneration())
    await act(() => result.current.generate())
    expect(start).toHaveBeenCalledWith({
      request: result.current.request,
      seed: null,
    })
    await act(() => result.current.stop())
    expect(stop).toHaveBeenCalledTimes(1)

    act(() => useVideoForm.setState({ prompt: '' }))
    await act(() => result.current.generate())
    expect(start).toHaveBeenCalledTimes(1)
  })
})
