import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeCatalog,
  makeFakeDiffusion,
  makeFilesFor,
  makeStatus,
} from '@/lib/diffusion/__tests__/image-fixtures'
import {
  makeVideoCapabilities,
  makeVideoEstimate,
  makeVideoLoadedStatus,
  makeWanCapabilities,
  LTX_2,
  LTX_Q4_ID,
  WAN_22,
  WAN_Q4_ID,
} from '@/lib/diffusion/__tests__/video-fixtures'
import { listInstalledArtifacts } from '@/lib/diffusion/models'
import { seedServiceHub } from '@/test/service-hub'
import { DEFAULT_VIDEO_FORM, useVideoForm } from '@/hooks/useVideoForm'
import { useVideoSetting } from '@/hooks/useVideoSetting'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useVideoGenerationStore } from '@/stores/video-generation-store'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useRemoteMediaForm } from '@/hooks/useRemoteMediaForm'
import fixture from '@/lib/__tests__/media-catalog.fixture.json'
import type { MediaCatalogView, VideoModelDescriptor } from '@/services/media/types'
import { useMediaCatalog } from '@/stores/media-catalog-store'
import { useVideoGeneration } from '../useVideoGeneration'

describe('useVideoGeneration', () => {
  let fake: ReturnType<typeof makeFakeDiffusion>
  beforeEach(() => {
    fake = makeFakeDiffusion()
    seedServiceHub({ diffusion: fake })
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
    ['emptyPrompt', () => useVideoForm.setState({ prompt: '   ' })],
    ['busy', () => useVideoGenerationStore.setState({ generating: true })],
    ['busy', () => useImageGenerationStore.setState({ generating: true })],
  ] as const)('is disabled for %s', (reason, arrange) => {
    arrange()
    const { result } = renderHook(() => useVideoGeneration())
    expect(result.current.disabledReason).toBe(reason)
    expect(result.current.canGenerate).toBe(false)
  })

  it('runs the resident video model the picker shows, whatever was picked before it', () => {
    useVideoSetting.setState({ selectedArtifactId: WAN_Q4_ID })
    const { result } = renderHook(() => useVideoGeneration())
    expect(result.current).toMatchObject({
      modelReady: true,
      targetArtifactId: LTX_Q4_ID,
      targetFamilyId: 'ltx-2',
      disabledReason: null,
    })
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
    expect(result.current.canGenerate).toBe(false)
    expect(result.current.disabledReason).toBe('emptyPrompt')
    await act(() => result.current.generate())
    expect(start).toHaveBeenCalledTimes(1)
  })

  describe('with the picked model stopped', () => {
    beforeEach(() => {
      const catalog = makeCatalog([LTX_2, WAN_22])
      const files = makeFilesFor(WAN_22, 'q4_k_m')
      useImageGenerationStore.setState({
        catalog,
        modelFiles: files,
        installedArtifacts: listInstalledArtifacts(catalog, files),
        status: makeStatus(),
        videoCapabilities: null,
      })
      useVideoSetting.setState({ selectedArtifactId: WAN_Q4_ID })
    })

    it('knows what the model takes before it starts, and lets Generate start it', () => {
      const { result } = renderHook(() => useVideoGeneration())
      expect(result.current).toMatchObject({
        modelReady: false,
        targetArtifactId: WAN_Q4_ID,
        targetFamilyId: 'wan2.2-ti2v-5b',
        canGenerate: true,
        disabledReason: null,
        capabilities: { supportsNegativePrompt: true, fps: 24 },
      })
    })

    it('starts the model, then generates the draft as it was set', async () => {
      useVideoForm.setState({ width: 704, height: 1280, steps: 12 })
      const loadModel = vi.fn(async (id: string) => {
        useImageGenerationStore.setState({
          status: makeVideoLoadedStatus(id, 'wan2.2-ti2v-5b'),
          videoCapabilities: makeWanCapabilities(),
        })
      })
      const start = vi.fn(async () => {})
      useImageGenerationStore.setState({ loadModel })
      useVideoGenerationStore.setState({ startGeneration: start })
      fake.estimateVideo.mockResolvedValue(makeVideoEstimate('fits'))
      const { result } = renderHook(() => useVideoGeneration())

      await act(() => result.current.generate())

      expect(loadModel).toHaveBeenCalledWith(WAN_Q4_ID)
      expect(fake.estimateVideo).toHaveBeenCalledTimes(1)
      expect(start).toHaveBeenCalledWith({
        request: expect.objectContaining({ width: 704, height: 1280, steps: 12 }),
        seed: null,
      })
      expect(result.current.modelReady).toBe(true)
      expect(useVideoForm.getState()).toMatchObject({
        width: 704,
        height: 1280,
        steps: 12,
      })
    })

    it('submits nothing when the model fails to start, and leaves Generate to retry', async () => {
      // What the store does on a failed start: the error, and no model.
      const loadModel = vi.fn(async () => {
        useImageGenerationStore.setState({
          lastError: { code: 'LOAD_FAILED', message: 'out of memory' },
        })
      })
      const start = vi.fn(async () => {})
      useImageGenerationStore.setState({ loadModel })
      useVideoGenerationStore.setState({ startGeneration: start })
      const { result } = renderHook(() => useVideoGeneration())

      await act(() => result.current.generate())

      expect(start).not.toHaveBeenCalled()
      expect(useImageGenerationStore.getState().lastError?.code).toBe(
        'LOAD_FAILED'
      )
      expect(result.current).toMatchObject({
        modelReady: false,
        canGenerate: true,
      })
    })
  })

  describe('before a clip that may not fit', () => {
    const arrange = (verdict: 'fits' | 'tight' | 'exceeds' | null) => {
      fake.estimateVideo.mockResolvedValue(
        verdict === null ? null : makeVideoEstimate(verdict)
      )
      const start = vi.fn(async () => {})
      useVideoGenerationStore.setState({ startGeneration: start })
      return { start, hook: renderHook(() => useVideoGeneration()) }
    }

    it.each(['fits', 'tight', null] as const)(
      'starts at once when the estimate is %s',
      async (verdict) => {
        const { start, hook } = arrange(verdict)
        await act(() => hook.result.current.generate())
        expect(start).toHaveBeenCalledTimes(1)
        expect(hook.result.current.confirmation.open).toBe(false)
      }
    )

    it('asks when it exceeds memory, and a cancel starts nothing', async () => {
      const { start, hook } = arrange('exceeds')
      await act(() => hook.result.current.generate())
      expect(start).not.toHaveBeenCalled()
      expect(hook.result.current.confirmation).toMatchObject({
        open: true,
        estimate: makeVideoEstimate('exceeds'),
      })
      act(() => hook.result.current.confirmation.onCancel())
      expect(hook.result.current.confirmation.open).toBe(false)
      expect(start).not.toHaveBeenCalled()
    })

    it('starts the draft that was asked about once the user says so anyway', async () => {
      useVideoForm.setState({ seedText: '11' })
      const { start, hook } = arrange('exceeds')
      await act(() => hook.result.current.generate())
      const asked = hook.result.current.request
      // The draft moves on behind the dialog; the answer is about the one that was asked.
      act(() => useVideoForm.setState({ prompt: 'a different prompt' }))
      act(() => hook.result.current.confirmation.onConfirm())
      expect(start).toHaveBeenCalledWith({ request: asked, seed: 11 })
      expect(hook.result.current.confirmation.open).toBe(false)
    })
  })

  describe("with a provider's model picked", () => {
    const veo: VideoModelDescriptor = {
      id: 'google/veo-3.1',
      name: 'Veo 3.1',
      kind: 'video',
      api: 'openrouter-videos',
      workflows: ['create', 'image-to-video'],
      params: {
        durations: { values: [4, 6, 8], default: 8 },
        resolutions: { values: ['720p', '1080p'], default: '720p' },
        aspect_ratios: { values: ['16:9', '9:16'], default: '16:9' },
        audio: true,
      },
      source: 'live',
    }

    beforeEach(() => {
      useMediaCatalog.setState({
        catalog: fixture as unknown as MediaCatalogView,
        available: true,
        status: 'ready',
        listings: {
          'openrouter:video': { status: 'ready', models: [veo], live: true, error: null },
        },
      })
      useModelProvider.setState({
        providers: [
          {
            provider: 'openrouter',
            active: true,
            api_key: 'sk-test',
            base_url: 'https://openrouter.ai/api/v1',
            models: [],
            settings: [],
            media: { models: [{ id: 'google/veo-3.1', kind: 'video' }] },
          },
        ] as unknown as ProviderObject[],
      })
      useRemoteMediaForm.setState({
        video: { durationSecs: 5, resolution: '1080p' },
        videoWorkflow: 'create',
        firstFrame: null,
      })
      useVideoSetting.setState({
        selectedRemote: { provider: 'openrouter', model: 'google/veo-3.1' },
      })
      // No engine on this machine: a provider's model does not need one.
      useImageGenerationStore.setState({ status: null, videoCapabilities: null })
    })

    it('sends the target and the settings the model takes, nothing of the local engine', () => {
      const { result } = renderHook(() => useVideoGeneration())
      expect(result.current.remote?.descriptor.id).toBe('google/veo-3.1')
      expect(result.current.disabledReason).toBeNull()
      expect(result.current.capabilities).toBeNull()
      expect(result.current.targetFamilyId).toBe('remote:openrouter/google/veo-3.1')
      expect(result.current.request).toEqual({
        prompt: 'a lighthouse',
        width: 1920,
        height: 1080,
        steps: 0,
        cfgScale: 0,
        workflow: 'create',
        target: { provider: 'openrouter', model: 'google/veo-3.1' },
        // 5 s is not offered: the model's default goes instead.
        remote: { durationSecs: 8, resolution: '1080p', aspectRatio: '16:9' },
      })
    })

    it('generates straight away: no model to start, no memory to ask about', async () => {
      const start = vi.fn(async () => {})
      useVideoGenerationStore.setState({ startGeneration: start })
      const { result } = renderHook(() => useVideoGeneration())
      await act(() => result.current.generate())
      const [[submitted]] = start.mock.calls as unknown as [[{ request: unknown }]]
      expect(submitted).toEqual({ request: result.current.request, seed: null })
      expect(submitted.request).toMatchObject({ target: { provider: 'openrouter' } })
      expect(fake.estimateVideo).not.toHaveBeenCalled()
      expect(fake.loadModel).not.toHaveBeenCalled()
    })

    it('needs a first frame for image to video, and sends it', () => {
      act(() => useRemoteMediaForm.setState({ videoWorkflow: 'image-to-video' }))
      const { result } = renderHook(() => useVideoGeneration())
      expect(result.current.disabledReason).toBe('noSource')
      act(() =>
        useRemoteMediaForm.getState().setFirstFrame({ path: '/pics/a.png', width: 1024, height: 576 })
      )
      expect(result.current.disabledReason).toBeNull()
      expect(result.current.request).toMatchObject({
        workflow: 'image-to-video',
        initImage: { path: '/pics/a.png' },
      })
    })

    it('refuses a mode the model does not have', () => {
      useMediaCatalog.setState({
        listings: {
          'openrouter:video': {
            status: 'ready',
            models: [{ ...veo, workflows: ['create'] }],
            live: true,
            error: null,
          },
        },
      })
      act(() => useRemoteMediaForm.setState({ videoWorkflow: 'image-to-video' }))
      const { result } = renderHook(() => useVideoGeneration())
      expect(result.current.disabledReason).toBe('unsupportedWorkflow')
    })

    it('falls back to the local model once the provider is gone', () => {
      useModelProvider.setState({ providers: [] })
      const { result } = renderHook(() => useVideoGeneration())
      expect(result.current.remote).toBeNull()
      expect(result.current.request).not.toHaveProperty('target')
    })
  })
})
