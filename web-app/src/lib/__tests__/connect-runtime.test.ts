import { describe, expect, it, vi } from 'vitest'
import { connectRuntime, connectTarget, isConnected } from '../connect-runtime'
import type { RuntimeDescriptor, RuntimeDetection } from '@/services/runtimes'

function runtime(id: string, name: string, apis: string[] = ['open_ai_compatible']) {
  return { id, name, apis } as unknown as RuntimeDescriptor
}

const byId = new Map(
  [
    runtime('ollama', 'Ollama'),
    runtime('llama-cpp', 'llama.cpp'),
    runtime('lm-studio', 'LM Studio'),
    runtime('koboldcpp', 'KoboldCpp'),
    runtime('comfyui', 'ComfyUI', ['native_http']),
    runtime('invokeai', 'InvokeAI', ['native_http']),
    runtime('sglang', 'SGLang', ['native_http']),
  ].map((r) => [r.id, r])
)

function detection(partial: Partial<RuntimeDetection>): RuntimeDetection {
  return {
    baseUrl: 'http://127.0.0.1:11434',
    runtimeId: 'ollama',
    confidence: 'confirmed',
    alternatives: [],
    version: null,
    models: [],
    loadedModels: [],
    devices: [],
    counters: null,
    ...partial,
  }
}

/** A tiny in-memory provider store with the same three calls the page uses. */
function store(initial: ModelProvider[] = []) {
  let providers = [...initial]
  return {
    get providers() {
      return providers
    },
    addProvider: (provider: ModelProvider) => {
      providers = [...providers, provider]
    },
    updateProvider: (name: string, data: Partial<ModelProvider>) => {
      providers = providers.map((p) => (p.provider === name ? { ...p, ...data } : p))
    },
    getProviderByName: (name: string) => providers.find((p) => p.provider === name),
  }
}

function hub(fetch: (provider: ModelProvider) => Promise<string[]>) {
  return { providers: () => ({ fetchModelsFromProvider: vi.fn(fetch) }) } as never
}

describe('connectTarget', () => {
  it('reuses the catalogue ids for Ollama and llama-server, and adds /v1', () => {
    expect(connectTarget(detection({}), byId)).toEqual({
      kind: 'provider',
      providerId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
    })
    expect(
      connectTarget(detection({ runtimeId: 'llama-cpp', baseUrl: 'http://127.0.0.1:8080/' }), byId)
    ).toEqual({ kind: 'provider', providerId: 'llamacpp-server', baseUrl: 'http://127.0.0.1:8080/v1' })
  })

  it('names other runtimes after the catalogue', () => {
    const target = connectTarget(
      detection({ runtimeId: 'lm-studio', baseUrl: 'http://127.0.0.1:1234' }),
      byId
    )
    expect(target).toMatchObject({ providerId: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' })
  })

  it('sends image runtimes to the Media page, and refuses runtimes with no OpenAI API', () => {
    expect(connectTarget(detection({ runtimeId: 'comfyui' }), byId)).toEqual({ kind: 'media' })
    expect(connectTarget(detection({ runtimeId: 'invokeai' }), byId)).toEqual({ kind: 'media' })
    expect(connectTarget(detection({ runtimeId: 'sglang' }), byId)).toBeNull()
  })

  it('names an unidentified OpenAI server by its port', () => {
    const target = connectTarget(
      detection({ runtimeId: null, confidence: 'port_guess', baseUrl: 'http://127.0.0.1:8000' }),
      byId
    )
    expect(target).toMatchObject({ providerId: 'Local server 8000' })
  })
})

describe('isConnected', () => {
  const target = { kind: 'provider' as const, providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }
  const provider = (partial: Partial<ModelProvider>): ModelProvider => ({
    provider: 'ollama',
    active: true,
    base_url: 'http://127.0.0.1:11434/v1/',
    settings: [],
    models: [{ id: 'qwen3:8b' }],
    ...partial,
  })

  it('needs the same address, active, and at least one model', () => {
    expect(isConnected(target, [provider({})])).toBe(true)
    expect(isConnected(target, [provider({ models: [] })])).toBe(false)
    expect(isConnected(target, [provider({ active: false })])).toBe(false)
    expect(isConnected(target, [provider({ base_url: 'http://192.168.1.5:11434/v1' })])).toBe(false)
    expect(isConnected({ kind: 'media' }, [provider({})])).toBe(false)
    expect(isConnected(null, [provider({})])).toBe(false)
  })
})

describe('connectRuntime', () => {
  it('adds a new provider with the base URL filled in and the live model list', async () => {
    const s = store()
    const result = await connectRuntime(
      { kind: 'provider', providerId: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
      ['from-scan'],
      { ...s, serviceHub: hub(async () => ['qwen3-8b', 'gemma-3-12b']) }
    )
    expect(result).toEqual({ providerId: 'LM Studio', modelCount: 2, usedScanModels: false })
    const added = s.getProviderByName('LM Studio')!
    expect(added.base_url).toBe('http://127.0.0.1:1234/v1')
    expect(added.active).toBe(true)
    expect(added.models.map((m) => m.id)).toEqual(['qwen3-8b', 'gemma-3-12b'])
    const baseUrlSetting = added.settings.find((setting) => setting.key === 'base-url')
    expect(baseUrlSetting?.controller_props.value).toBe('http://127.0.0.1:1234/v1')
  })

  it('updates the existing Ollama entry instead of adding a second one, keeping its models', async () => {
    const s = store([
      {
        provider: 'ollama',
        active: false,
        base_url: 'http://localhost:11434/v1',
        api_key: '',
        settings: [
          { key: 'base-url', title: 'Base URL', description: '', controller_type: 'input', controller_props: { value: 'http://localhost:11434/v1' } },
        ],
        models: [{ id: 'kept', name: 'kept' }],
      },
    ])
    await connectRuntime(
      { kind: 'provider', providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
      [],
      { ...s, serviceHub: hub(async () => ['qwen3:8b', 'kept']) }
    )
    expect(s.providers).toHaveLength(1)
    const ollama = s.providers[0]
    expect(ollama.active).toBe(true)
    expect(ollama.base_url).toBe('http://127.0.0.1:11434/v1')
    expect(ollama.settings[0].controller_props.value).toBe('http://127.0.0.1:11434/v1')
    expect(ollama.models.map((m) => m.id)).toEqual(['kept', 'qwen3:8b'])
  })

  it('falls back to the models the scan saw when /v1/models fails', async () => {
    const s = store()
    const result = await connectRuntime(
      { kind: 'provider', providerId: 'KoboldCpp', baseUrl: 'http://127.0.0.1:5001/v1' },
      ['koboldcpp/Mistral-7B'],
      { ...s, serviceHub: hub(async () => Promise.reject(new Error('timeout'))) }
    )
    expect(result.usedScanModels).toBe(true)
    expect(s.getProviderByName('KoboldCpp')!.models.map((m) => m.id)).toEqual(['koboldcpp/Mistral-7B'])
  })

  it('refuses a server with no models at all, and says what to do', async () => {
    const s = store()
    await expect(
      connectRuntime(
        { kind: 'provider', providerId: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
        [],
        { ...s, serviceHub: hub(async () => []) }
      )
    ).rejects.toThrow('Load or download a model')
  })
})
