import { afterEach, describe, expect, it } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'

import {
  isLocalProvider,
  isSelfHostedProviderName,
  LOCAL_PROVIDER_NAMES,
} from '../registerRemoteProvider'

describe('isLocalProvider', () => {
  it('counts TensorRT-LLM as a local engine, never a remote provider to register', () => {
    // A local engine that slipped into the remote path would be registered with
    // the proxy under its own name and shadow the session the core serves.
    expect(LOCAL_PROVIDER_NAMES).toContain('tensorrt-llm')
    expect(isLocalProvider('tensorrt-llm')).toBe(true)
    expect(LOCAL_PROVIDER_NAMES).toContain('vllm')
    expect(isLocalProvider('vllm')).toBe(true)
    expect(LOCAL_PROVIDER_NAMES).toContain('sglang')
    expect(isLocalProvider('sglang')).toBe(true)
    expect(LOCAL_PROVIDER_NAMES).toContain('foundry-local')
    expect(isLocalProvider('foundry-local')).toBe(true)
    expect(isLocalProvider('nvidia')).toBe(false)
  })

  it("keeps the media-only servers the app ships remote and the user's own", () => {
    for (const name of ['automatic1111', 'sdcpp-server']) {
      expect(isLocalProvider(name), name).toBe(false)
      expect(isSelfHostedProviderName(name), name).toBe(true)
    }
  })
})

describe('registerRemoteProvider media', () => {
  const provider = (patch: Partial<ModelProvider> = {}): ModelProvider =>
    ({
      provider: 'openai',
      active: true,
      api_key: 'sk-test',
      base_url: 'https://api.openai.com/v1',
      settings: [],
      models: [{ id: 'gpt-5' }],
      ...patch,
    }) as unknown as ModelProvider

  const registered = async (patch: Partial<ModelProvider>) => {
    const requests: unknown[] = []
    mockIPC((command, args) => {
      if (command === 'register_provider_config')
        requests.push((args as { request: unknown }).request)
    })
    const { registerRemoteProvider } = await import('../registerRemoteProvider')
    await registerRemoteProvider(provider(patch))
    return requests[0] as Record<string, unknown>
  }

  afterEach(() => clearMocks())

  it('sends the enabled media models, ids and kinds only', async () => {
    const request = await registered({
      media: {
        image_api: 'a1111',
        models: [{ id: 'sdxl', kind: 'image', name: 'SDXL' }],
      },
    })
    expect(request.media).toEqual({
      image_api: 'a1111',
      models: [{ id: 'sdxl', kind: 'image' }],
    })
  })

  it('sends no media field for a provider that never had any, so the core keeps its own', async () => {
    const request = await registered({})
    expect(request).not.toHaveProperty('media')
  })

  it('registers a keyless media-only server', async () => {
    const request = await registered({
      provider: 'automatic1111',
      api_key: '',
      base_url: 'http://127.0.0.1:7860',
      models: [],
      media_only: true,
      media: { models: [] },
    })
    expect(request).toMatchObject({ provider: 'automatic1111', models: [], media: { models: [] } })
  })
})
