import { describe, expect, it } from 'vitest'

import {
  agentContextWindow,
  agentProviderBlockReason,
  isAgentCapableProvider,
  isAgentLocalProvider,
  type AgentProviderBlockReason,
} from '../agent-provider'

function provider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    active: true,
    provider: 'openai',
    settings: [],
    models: [],
    api_key: 'sk-test',
    base_url: 'https://api.openai.com/v1',
    ...overrides,
  } as ModelProvider
}

function model(capabilities: string[] = ['tools']): Model {
  return { id: 'test-model', capabilities } as Model
}

describe('isAgentLocalProvider', () => {
  it('covers the three engines the backend can reach directly', () => {
    expect(isAgentLocalProvider('llamacpp')).toBe(true)
    expect(isAgentLocalProvider('llamacpp-upstream')).toBe(true)
    expect(isAgentLocalProvider('mlx')).toBe(true)
  })

  it('excludes foundation-models and unknown values', () => {
    expect(isAgentLocalProvider('foundation-models')).toBe(false)
    expect(isAgentLocalProvider('openai')).toBe(false)
    expect(isAgentLocalProvider(undefined)).toBe(false)
    expect(isAgentLocalProvider(null)).toBe(false)
  })
})

describe('agentProviderBlockReason', () => {
  const cases: Array<{
    name: string
    provider: ModelProvider | undefined
    model: Model | undefined
    expected: AgentProviderBlockReason | null
  }> = [
    {
      name: 'llamacpp with a model',
      provider: provider({ provider: 'llamacpp', api_key: '' }),
      model: model([]),
      expected: null,
    },
    {
      name: 'llamacpp-upstream with a model',
      provider: provider({ provider: 'llamacpp-upstream', api_key: '' }),
      model: model([]),
      expected: null,
    },
    {
      // Local engines need neither a key nor a declared `tools` capability:
      // the backend drives them with its own constrained-decoding contract.
      name: 'mlx with a model and no key',
      provider: provider({ provider: 'mlx', api_key: '' }),
      model: model([]),
      expected: null,
    },
    {
      name: 'local provider with no model selected',
      provider: provider({ provider: 'mlx', api_key: '' }),
      model: undefined,
      expected: 'no-model',
    },
    {
      name: 'foundation-models has no drivable endpoint',
      provider: provider({ provider: 'foundation-models', api_key: '' }),
      model: model(),
      expected: 'unsupported-provider',
    },
    {
      name: 'keyless loopback provider (Ollama) is out of scope',
      provider: provider({
        provider: 'ollama',
        api_key: '',
        base_url: 'http://localhost:11434/v1',
      }),
      model: model(),
      expected: 'unsupported-provider',
    },
    {
      name: 'cloud provider with a key and tool support',
      provider: provider(),
      model: model(['tools', 'vision']),
      expected: null,
    },
    {
      name: 'cloud provider missing a key',
      provider: provider({ api_key: '   ' }),
      model: model(),
      expected: 'missing-api-key',
    },
    {
      name: 'cloud model without tool support',
      provider: provider(),
      model: model(['vision']),
      expected: 'no-tool-support',
    },
    {
      name: 'cloud model with no capabilities reported',
      provider: provider(),
      model: { id: 'test-model' } as Model,
      expected: 'no-tool-support',
    },
    {
      name: 'unknown custom provider behaves like any cloud provider',
      provider: provider({
        provider: 'my-gateway',
        base_url: 'https://gateway.example.com/v1',
      }),
      model: model(),
      expected: null,
    },
    {
      name: 'no provider at all',
      provider: undefined,
      model: model(),
      expected: 'unsupported-provider',
    },
  ]

  it.each(cases)('$name', ({ provider, model, expected }) => {
    expect(agentProviderBlockReason(provider, model)).toBe(expected)
    expect(isAgentCapableProvider(provider, model)).toBe(expected === null)
  })
})

describe('agentContextWindow', () => {
  function withCtxLen(value: unknown): Model {
    return {
      id: 'test-model',
      settings: { ctx_len: { controller_props: { value } } },
    } as unknown as Model
  }

  it('reads the configured context length', () => {
    expect(agentContextWindow(withCtxLen(16384))).toBe(16384)
    expect(agentContextWindow(withCtxLen('32768'))).toBe(32768)
  })

  it('returns undefined when there is nothing usable to report', () => {
    expect(agentContextWindow(undefined)).toBeUndefined()
    expect(agentContextWindow({ id: 'test-model' } as Model)).toBeUndefined()
    expect(agentContextWindow(withCtxLen(0))).toBeUndefined()
    expect(agentContextWindow(withCtxLen(-1))).toBeUndefined()
    expect(agentContextWindow(withCtxLen('not a number'))).toBeUndefined()
  })
})
