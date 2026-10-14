import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDiffusion } from '@/lib/diffusion/__tests__/image-fixtures'
import { DEFAULT_IMAGE_FORM, useImageForm } from '@/hooks/useImageForm'
import { useImageSetting } from '@/hooks/useImageSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useRemoteMediaForm } from '@/hooks/useRemoteMediaForm'
import fixture from '@/lib/__tests__/media-catalog.fixture.json'
import type { ImageModelDescriptor, MediaCatalogView } from '@/services/media/types'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useMediaCatalog } from '@/stores/media-catalog-store'
import { seedServiceHub } from '@/test/service-hub'
import { useImageGeneration } from '../useImageGeneration'

const gptImage: ImageModelDescriptor = {
  id: 'gpt-image-2',
  name: 'GPT Image 2',
  kind: 'image',
  api: 'openai-images',
  workflows: ['create', 'edit', 'inpaint'],
  params: {
    size: { kind: 'enum', values: ['1024x1024', '1536x1024'], default: '1024x1024' },
    quality: { values: ['low', 'high'], default: 'high' },
    n: { max: 4 },
  },
  source: 'live',
}

const a1111: ImageModelDescriptor = {
  id: 'sdxl.safetensors',
  name: 'SDXL',
  kind: 'image',
  api: 'a1111',
  workflows: ['create', 'transform'],
  params: {
    size: { kind: 'range', min: 64, max: 2048, multiple: 8, default_width: 1024, default_height: 1024 },
    steps: { min: 1, max: 150, default: 25 },
    cfg: { min: 1, max: 30, default: 7 },
    negative_prompt: true,
    seed: true,
  },
  source: 'live',
}

const pick = (provider: string, model: string) =>
  useImageSetting.setState({ selectedRemote: { provider, model } })

describe("useImageGeneration with a provider's model", () => {
  let fake: ReturnType<typeof makeFakeDiffusion>

  beforeEach(() => {
    fake = makeFakeDiffusion()
    seedServiceHub({ diffusion: fake })
    useImageGenerationStore.getState().reset()
    // No engine on this machine: a provider's model does not need one.
    useImageGenerationStore.setState({ status: null })
    useImageForm.setState({
      ...DEFAULT_IMAGE_FORM,
      prompt: 'a lighthouse',
      negativePrompt: 'blurry',
      steps: 30,
      cfgScale: 5,
      width: 832,
      height: 1216,
      batchSize: 8,
      workflow: 'create',
    })
    useRemoteMediaForm.setState({ image: { size: '1536x1024', quality: 'ultra' } })
    useMediaCatalog.setState({
      catalog: fixture as unknown as MediaCatalogView,
      available: true,
      status: 'ready',
      listings: {
        'openai:image': { status: 'ready', models: [gptImage], live: true, error: null },
        'automatic1111:image': { status: 'ready', models: [a1111], live: true, error: null },
      },
    })
    useModelProvider.setState({
      providers: [
        {
          provider: 'openai',
          active: true,
          api_key: 'sk-test',
          base_url: 'https://api.openai.com/v1',
          models: [],
          settings: [],
          media: { models: [{ id: 'gpt-image-2', kind: 'image' }] },
        },
        {
          provider: 'automatic1111',
          active: true,
          api_key: '',
          base_url: 'http://127.0.0.1:7860',
          models: [],
          settings: [],
          media_only: true,
          media: { image_api: 'a1111', models: [{ id: 'sdxl.safetensors', kind: 'image' }] },
        },
      ] as unknown as ProviderObject[],
    })
    useImageSetting.setState({ selectedRemote: null })
  })

  it('sends a cloud model the target and its own settings, none of the local sampling', () => {
    pick('openai', 'gpt-image-2')
    const { result } = renderHook(() => useImageGeneration())
    expect(result.current.disabledReason).toBeNull()
    expect(result.current.targetFamilyId).toBe('remote:openai/gpt-image-2')
    expect(result.current.outputSize).toEqual({ width: 1536, height: 1024 })
    expect(result.current.request).toMatchObject({
      prompt: 'a lighthouse',
      width: 1536,
      height: 1024,
      steps: 0,
      cfgScale: 0,
      batchSize: 4,
      workflow: 'create',
      target: { provider: 'openai', model: 'gpt-image-2' },
      // `ultra` is not offered: the model's default goes instead.
      remote: { size: '1536x1024', quality: 'high' },
    })
    expect(result.current.request.negativePrompt).toBeUndefined()
    expect(result.current.request).not.toHaveProperty('samplingMethod')
  })

  it("keeps a self-hosted server's steps, CFG, negative prompt and free size", () => {
    pick('automatic1111', 'sdxl.safetensors')
    const { result } = renderHook(() => useImageGeneration())
    expect(result.current.request).toMatchObject({
      width: 832,
      height: 1216,
      steps: 30,
      cfgScale: 5,
      negativePrompt: 'blurry',
      batchSize: 1,
      target: { provider: 'automatic1111', model: 'sdxl.safetensors' },
      remote: {},
    })
  })

  it('generates without starting a local model', async () => {
    pick('openai', 'gpt-image-2')
    const start = vi.fn(async () => {})
    useImageGenerationStore.setState({ startGeneration: start })
    const { result } = renderHook(() => useImageGeneration())
    await act(() => result.current.generate())
    const [[submitted]] = start.mock.calls as unknown as [[{ request: unknown; runs: number }]]
    expect(submitted).toEqual({ request: result.current.request, runs: 1, baseSeed: null })
    expect(submitted.request).toMatchObject({ target: { provider: 'openai', model: 'gpt-image-2' } })
    expect(fake.loadModel).not.toHaveBeenCalled()
  })

  it('says why it cannot generate', () => {
    pick('openai', 'gpt-image-2')
    const { result } = renderHook(() => useImageGeneration())
    act(() => useImageForm.setState({ workflow: 'upscale' }))
    expect(result.current.disabledReason).toBe('unsupportedWorkflow')
    act(() => useImageForm.setState({ workflow: 'edit' }))
    expect(result.current.disabledReason).toBe('noSource')
    act(() =>
      useImageForm.setState({
        workflow: 'inpaint',
        sourceImage: { path: '/pics/a.png', width: 1024, height: 1024 },
      })
    )
    expect(result.current.disabledReason).toBe('noMask')
    act(() => useImageForm.setState({ workflow: 'create', prompt: '  ' }))
    expect(result.current.disabledReason).toBe('emptyPrompt')
  })

  it('sends the source of an edit', () => {
    pick('openai', 'gpt-image-2')
    useImageForm.setState({
      workflow: 'edit',
      sourceImage: { path: '/pics/a.png', width: 1024, height: 1024 },
    })
    const { result } = renderHook(() => useImageGeneration())
    expect(result.current.request).toMatchObject({
      workflow: 'edit',
      initImage: { path: '/pics/a.png' },
      target: { provider: 'openai', model: 'gpt-image-2' },
    })
  })

  it('goes back to the local model when the picked one is removed', () => {
    pick('openai', 'gpt-image-2')
    useModelProvider.setState({ providers: [] })
    const { result } = renderHook(() => useImageGeneration())
    expect(result.current.remote).toBeNull()
    expect(result.current.request).not.toHaveProperty('target')
  })
})
