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
    expected: AgentProviderBlockReason | null
  }> = [
    {
      name: 'llamacpp',
      provider: provider({ provider: 'llamacpp', api_key: '' }),
      expected: null,
    },
    {
      name: 'llamacpp-upstream',
      provider: provider({ provider: 'llamacpp-upstream', api_key: '' }),
      expected: null,
    },
    {
      // Local engines need no key: the backend drives their sessions directly.
      name: 'mlx with no key',
      provider: provider({ provider: 'mlx', api_key: '' }),
      expected: null,
    },
    {
      name: 'foundation-models has no drivable endpoint',
      provider: provider({ provider: 'foundation-models', api_key: '' }),
      expected: 'unsupported-provider',
    },
    {
      // Registered with the proxy on exactly this condition by DataProvider,
      // and the proxy needs no upstream key for it.
      name: 'keyless loopback provider (Ollama) needs no key',
      provider: provider({
        provider: 'ollama',
        api_key: '',
        base_url: 'http://localhost:11434/v1',
      }),
      expected: null,
    },
    {
      name: 'non-loopback provider still needs a key',
      provider: provider({
        provider: 'openrouter',
        api_key: '',
        base_url: 'https://openrouter.ai/api/v1',
      }),
      expected: 'missing-api-key',
    },
    {
      name: 'cloud provider with a key',
      provider: provider(),
      expected: null,
    },
    {
      name: 'cloud provider missing a key',
      provider: provider({ api_key: '   ' }),
      expected: 'missing-api-key',
    },
    {
      name: 'unknown custom provider behaves like any cloud provider',
      provider: provider({
        provider: 'my-gateway',
        base_url: 'https://gateway.example.com/v1',
      }),
      expected: null,
    },
    {
      name: 'no provider at all',
      provider: undefined,
      expected: 'unsupported-provider',
    },
  ]

  it.each(cases)('$name', ({ provider, expected }) => {
    expect(agentProviderBlockReason(provider)).toBe(expected)
    expect(isAgentCapableProvider(provider)).toBe(expected === null)
  })

  /**
   * Agent mode never uses native OpenAI function calling — the tool contract is
   * a text JSON array carried by the prompt. Gating on the `tools` capability
   * would block every model missing from the static capability table.
   */
  it('does not require the tools capability', () => {
    expect(agentProviderBlockReason(provider())).toBeNull()
  })

  /**
   * The sidebar toggle asks this before a model is necessarily selected; the
   * model is validated at run time instead.
   */
  it('does not depend on a selected model', () => {
    expect(
      agentProviderBlockReason(provider({ provider: 'mlx', api_key: '' }))
    ).toBeNull()
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
