import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ModelFactory, createLocalStreamingFetch } from '../model-factory'
import type { ProviderObject } from '@janhq/core'
import { invoke } from '@tauri-apps/api/core'
import type { ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'

// Mock the Tauri invoke function
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null
  },
}))

// Mock the Tauri HTTP plugin
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}))

// Mock the AI SDK providers
vi.mock('@ai-sdk/openai-compatible', () => {
  const MockChatModel = vi.fn().mockImplementation(() => ({
    type: 'foundation-models',
    modelId: 'apple/on-device',
  }))
  return {
    createOpenAICompatible: vi.fn(() => ({
      languageModel: vi.fn(() => ({ type: 'openai-compatible' })),
    })),
    OpenAICompatibleChatLanguageModel: MockChatModel,
    MetadataExtractor: vi.fn(),
  }
})

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => ({ type: 'anthropic' }))),
}))

vi.mock('ai', () => ({
  wrapLanguageModel: vi.fn(({ model }) => model),
  extractReasoningMiddleware: vi.fn(() => ({})),
}))

const mockStartModel = vi.fn().mockResolvedValue(undefined)

const mockedInvoke = vi.mocked(invoke)

describe('ModelFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStartModel.mockResolvedValue(undefined)
    seedServiceHub({
      models: {
        startModel: mockStartModel,
      } as ModelsService,
    })
    ModelFactory.invalidateFoundationModelsAvailabilityCache()
  })

  describe('createModel', () => {
    it('should create an Anthropic model for anthropic provider', async () => {
      const provider: ProviderObject = {
        provider: 'anthropic',
        api_key: 'test-api-key',
        base_url: 'https://api.anthropic.com/v1',
        models: [],
        settings: [],
        active: true,
        custom_header: [{ header: 'anthropic-version', value: '2023-06-01' }],
      }

      const model = await ModelFactory.createModel('claude-3-opus', provider)
      expect(model).toBeDefined()
      expect(model.type).toBe('anthropic')
    })

    it('should create a Google model for google provider', async () => {
      const provider: ProviderObject = {
        provider: 'google',
        api_key: 'test-api-key',
        base_url: 'https://generativelanguage.googleapis.com/v1',
        models: [],
        settings: [],
        active: true,
      }

      const model = await ModelFactory.createModel('gemini-pro', provider)
      expect(model).toBeDefined()
      expect(model.type).toBe('openai-compatible')
    })

    it('should create a Google model for gemini provider', async () => {
      const provider: ProviderObject = {
        provider: 'gemini',
        api_key: 'test-api-key',
        base_url: 'https://generativelanguage.googleapis.com/v1',
        models: [],
        settings: [],
        active: true,
      }

      const model = await ModelFactory.createModel('gemini-pro', provider)
      expect(model).toBeDefined()
      expect(model.type).toBe('openai-compatible')
    })

    it('should create an OpenAI-compatible model for openai provider', async () => {
      const provider: ProviderObject = {
        provider: 'openai',
        api_key: 'test-api-key',
        base_url: 'https://api.openai.com/v1',
        models: [],
        settings: [],
        active: true,
      }

      const model = await ModelFactory.createModel('gpt-4', provider)
      expect(model).toBeDefined()
    })

    it('should create an OpenAI-compatible model for groq provider', async () => {
      const provider: ProviderObject = {
        provider: 'groq',
        api_key: 'test-api-key',
        base_url: 'https://api.groq.com/openai/v1',
        models: [],
        settings: [],
        active: true,
      }

      const model = await ModelFactory.createModel('llama-3', provider)
      expect(model).toBeDefined()
      expect(model.type).toBe('openai-compatible')
    })

    it('should create an OpenAI-compatible model for minimax provider', async () => {
      const provider: ProviderObject = {
        provider: 'minimax',
        api_key: 'test-api-key',
        base_url: 'https://api.minimax.io/v1',
        models: [],
        settings: [],
        active: true,
      }

      const model = await ModelFactory.createModel('MiniMax-M2.7', provider)
      expect(model).toBeDefined()
      expect(model.type).toBe('openai-compatible')
    })

    it('should handle custom headers for OpenAI-compatible providers', async () => {
      const provider: ProviderObject = {
        provider: 'custom',
        api_key: 'test-api-key',
        base_url: 'https://custom.api.com/v1',
        models: [],
        settings: [],
        active: true,
        custom_header: [{ header: 'X-Custom-Header', value: 'custom-value' }],
      }

      const model = await ModelFactory.createModel('custom-model', provider)
      expect(model).toBeDefined()
      expect(model.type).toBe('openai-compatible')
    })
  })

  describe('foundation-models provider', () => {
    const foundationModelsProvider: ProviderObject = {
      provider: 'foundation-models',
      models: [],
      settings: [],
      active: true,
    }

    it('should throw with notEligible message when device is not eligible', async () => {
      mockedInvoke.mockResolvedValueOnce('notEligible')

      await expect(
        ModelFactory.createModel('apple/on-device', foundationModelsProvider)
      ).rejects.toThrow(
        'Apple Intelligence is not supported on this device. An Apple Silicon Mac (M1 or later) with macOS 26+ is required.'
      )

      expect(mockedInvoke).toHaveBeenCalledWith(
        'plugin:foundation-models|check_foundation_models_availability',
        {}
      )
    })

    it('should throw when Apple Intelligence is not enabled', async () => {
      mockedInvoke.mockResolvedValueOnce('appleIntelligenceNotEnabled')

      await expect(
        ModelFactory.createModel('apple/on-device', foundationModelsProvider)
      ).rejects.toThrow(
        'Apple Intelligence is not enabled. Please enable it in System Settings > Apple Intelligence & Siri.'
      )
    })

    it('should throw when the model is not ready', async () => {
      mockedInvoke.mockResolvedValueOnce('modelNotReady')

      await expect(
        ModelFactory.createModel('apple/on-device', foundationModelsProvider)
      ).rejects.toThrow(
        'The Apple on-device model is still preparing. Please wait and try again shortly.'
      )
    })

    it('should throw when the server binary is missing', async () => {
      mockedInvoke.mockResolvedValueOnce('binaryNotFound')

      await expect(
        ModelFactory.createModel('apple/on-device', foundationModelsProvider)
      ).rejects.toThrow(
        'The Foundation Models server binary is missing. Please reinstall the app.'
      )
    })

    it('should throw with generic unavailable message for unknown status', async () => {
      mockedInvoke.mockResolvedValueOnce('unavailable')

      await expect(
        ModelFactory.createModel('apple/on-device', foundationModelsProvider)
      ).rejects.toThrow(
        'Apple Foundation Models are currently unavailable on this device.'
      )
    })

    it('should throw when available but no session is found after start', async () => {
      mockedInvoke
        .mockResolvedValueOnce('available') // check_foundation_models_availability
        .mockResolvedValueOnce(null) // find_foundation_models_session

      await expect(
        ModelFactory.createModel('apple/on-device', foundationModelsProvider)
      ).rejects.toThrow(
        'No running Foundation Models session. The server may have failed to start'
      )
    })

    it('should create a model when available and session exists', async () => {
      mockedInvoke
        .mockResolvedValueOnce('available') // check_foundation_models_availability
        .mockResolvedValueOnce({
          // find_foundation_models_session
          pid: 12345,
          port: 9876,
          model_id: 'apple/on-device',
          api_key: 'test-session-key',
        })

      const model = await ModelFactory.createModel(
        'apple/on-device',
        foundationModelsProvider
      )

      expect(model).toBeDefined()
      expect(mockedInvoke).toHaveBeenCalledWith(
        'plugin:foundation-models|check_foundation_models_availability',
        {}
      )
      expect(mockedInvoke).toHaveBeenCalledWith(
        'plugin:foundation-models|find_foundation_models_session',
        {}
      )
    })
  })
})

describe('countLocalPromptTokens', () => {
  const session = { port: 4242, api_key: 'k', model_id: 'm' }

  beforeEach(() => {
    ModelFactory.invalidateLocalSessionCache('llamacpp-upstream', 'm')
  })

  it('renders the prompt through /apply-template WITH tools and tokenizes it', async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'plugin:llamacpp-upstream|find_session_by_model') return session
      const { url } = args as { url: string; body: string }
      if (url.endsWith('/apply-template')) {
        const body = JSON.parse((args as { body: string }).body)
        expect(body.tools).toHaveLength(1)
        expect(body.messages[0]).toEqual({ role: 'user', content: 'yo' })
        return JSON.stringify({ prompt: '<rendered prompt>' })
      }
      if (url.endsWith('/tokenize')) {
        expect(JSON.parse((args as { body: string }).body)).toEqual({
          content: '<rendered prompt>',
        })
        return JSON.stringify({ tokens: [1, 2, 3, 4, 5] })
      }
      throw new Error(`unexpected ${cmd} ${url}`)
    })

    const count = await ModelFactory.countLocalPromptTokens(
      'llamacpp-upstream',
      'm',
      undefined,
      {
        messages: [{ role: 'user', content: 'yo' }],
        tools: [{ type: 'function', function: { name: 't', parameters: {} } }],
      }
    )

    expect(count).toBe(5)
    expect(mockedInvoke).toHaveBeenCalledWith(
      'post_local_http',
      expect.objectContaining({
        url: 'http://localhost:4242/apply-template',
        timeoutSecs: 3,
      })
    )
  })

  it('returns null instead of throwing when the engine cannot answer', async () => {
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'plugin:llamacpp-upstream|find_session_by_model') return session
      throw new Error('timeout')
    })
    expect(
      await ModelFactory.countLocalPromptTokens('llamacpp-upstream', 'm', undefined, {
        messages: [],
      })
    ).toBeNull()
  })
})

describe('createLocalStreamingFetch error mapping', () => {
  it('turns a context-overflow 500 into a non-retryable 400 with the same body', async () => {
    const body = JSON.stringify({
      error: {
        code: 500,
        message:
          'the request exceeds the available context size. Try increasing context size or enable context shift',
      },
    })
    mockedInvoke.mockRejectedValueOnce(`HTTP 500: ${body}`)
    const localFetch = createLocalStreamingFetch(vi.fn(), {})

    const response = await localFetch('http://localhost:4242/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [] }),
    })

    expect(response.status).toBe(400)
    expect(await response.text()).toBe(body)
  })

  it('leaves other 5xx untouched', async () => {
    mockedInvoke.mockRejectedValueOnce('HTTP 503: {"error":{"message":"loading"}}')
    const localFetch = createLocalStreamingFetch(vi.fn(), {})
    const response = await localFetch('http://localhost:4242/v1/chat/completions', {
      method: 'POST',
      body: '{}',
    })
    expect(response.status).toBe(503)
  })
})
