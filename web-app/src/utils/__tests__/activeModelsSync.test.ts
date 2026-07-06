import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  preserveActiveCloudModels,
  syncActiveModelsFromEngines,
  hydrateActiveModelsForRunningServer,
} from '../activeModelsSync'
import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'

function makeProvider(
  provider: string,
  models: Array<{ id: string }>,
  overrides: Partial<ModelProvider> = {}
): ModelProvider {
  return {
    provider,
    active: true,
    models,
    ...overrides,
  } as unknown as ModelProvider
}

describe('preserveActiveCloudModels', () => {
  beforeEach(() => {
    useAppState.setState({ activeModels: [] })
    useModelProvider.setState({ providers: [] })
  })

  it('returns just the fresh local models when there are no previously active cloud models', () => {
    const result = preserveActiveCloudModels(['qwen3-4b'])
    expect(result).toEqual(['qwen3-4b'])
  })

  it('treats null/undefined freshLocal as an empty list', () => {
    expect(preserveActiveCloudModels(null)).toEqual([])
    expect(preserveActiveCloudModels(undefined)).toEqual([])
  })

  it('keeps a previously-active cloud model alongside fresh local models', () => {
    const cloudProvider = makeProvider('openai', [{ id: 'gpt-5.4' }])
    useModelProvider.setState({ providers: [cloudProvider] })
    useAppState.setState({ activeModels: ['gpt-5.4'] })

    const result = preserveActiveCloudModels(['qwen3-4b'])

    expect(result).toEqual(['qwen3-4b', 'gpt-5.4'])
  })

  it('drops a previously-active model owned by a local provider (already covered by freshLocal)', () => {
    const localProvider = makeProvider('llamacpp-upstream', [{ id: 'qwen3-4b' }])
    useModelProvider.setState({ providers: [localProvider] })
    useAppState.setState({ activeModels: ['qwen3-4b'] })

    const result = preserveActiveCloudModels([])

    expect(result).toEqual([])
  })

  it('drops a stale active model whose owning provider cannot be resolved', () => {
    useModelProvider.setState({ providers: [] })
    useAppState.setState({ activeModels: ['ghost-model'] })

    const result = preserveActiveCloudModels(['qwen3-4b'])

    expect(result).toEqual(['qwen3-4b'])
  })

  it('de-duplicates when the same model appears in both lists', () => {
    const cloudProvider = makeProvider('openai', [{ id: 'gpt-5.4' }])
    useModelProvider.setState({ providers: [cloudProvider] })
    useAppState.setState({ activeModels: ['gpt-5.4'] })

    const result = preserveActiveCloudModels(['gpt-5.4'])

    expect(result).toEqual(['gpt-5.4'])
  })
})

describe('syncActiveModelsFromEngines', () => {
  beforeEach(() => {
    useAppState.setState({ activeModels: [] })
    useModelProvider.setState({ providers: [] })
  })

  it('replaces activeModels with the local list merged with retained cloud models', () => {
    const cloudProvider = makeProvider('openai', [{ id: 'gpt-5.4' }])
    useModelProvider.setState({ providers: [cloudProvider] })
    useAppState.setState({ activeModels: ['gpt-5.4'] })

    syncActiveModelsFromEngines(['qwen3-4b'])

    expect(useAppState.getState().activeModels).toEqual(['qwen3-4b', 'gpt-5.4'])
  })
})

describe('hydrateActiveModelsForRunningServer', () => {
  beforeEach(() => {
    useAppState.setState({ activeModels: [] })
    useModelProvider.setState({ providers: [] })
    useLocalApiServer.setState({ defaultModelLocalApiServer: null })
  })

  it('sets activeModels from getActiveModels() when there is no server default', async () => {
    const modelsService = {
      getActiveModels: vi.fn().mockResolvedValue(['qwen3-4b']),
    }

    await hydrateActiveModelsForRunningServer(modelsService)

    expect(useAppState.getState().activeModels).toEqual(['qwen3-4b'])
  })

  it('falls back to an empty list when getActiveModels() rejects', async () => {
    const modelsService = {
      getActiveModels: vi.fn().mockRejectedValue(new Error('boom')),
    }

    await hydrateActiveModelsForRunningServer(modelsService)

    expect(useAppState.getState().activeModels).toEqual([])
  })

  it('adds the server default cloud model when it has credentials', async () => {
    const cloudProvider = makeProvider('openai', [{ id: 'gpt-5.4' }], {
      api_key: 'sk-test',
    })
    useModelProvider.setState({ providers: [cloudProvider] })
    useLocalApiServer.setState({
      defaultModelLocalApiServer: { model: 'gpt-5.4', provider: 'openai' },
    })
    const modelsService = {
      getActiveModels: vi.fn().mockResolvedValue([]),
    }

    await hydrateActiveModelsForRunningServer(modelsService)

    expect(useAppState.getState().activeModels).toEqual(['gpt-5.4'])
  })

  it('does not add the server default cloud model when it has no API key', async () => {
    const cloudProvider = makeProvider('openai', [{ id: 'gpt-5.4' }], {
      api_key: '',
    })
    useModelProvider.setState({ providers: [cloudProvider] })
    useLocalApiServer.setState({
      defaultModelLocalApiServer: { model: 'gpt-5.4', provider: 'openai' },
    })
    const modelsService = {
      getActiveModels: vi.fn().mockResolvedValue([]),
    }

    await hydrateActiveModelsForRunningServer(modelsService)

    expect(useAppState.getState().activeModels).toEqual([])
  })

  it('does not add the server default when its provider is a local engine', async () => {
    const localProvider = makeProvider('llamacpp-upstream', [{ id: 'qwen3-4b' }])
    useModelProvider.setState({ providers: [localProvider] })
    useLocalApiServer.setState({
      defaultModelLocalApiServer: { model: 'qwen3-4b', provider: 'llamacpp-upstream' },
    })
    const modelsService = {
      getActiveModels: vi.fn().mockResolvedValue(['qwen3-4b']),
    }

    await hydrateActiveModelsForRunningServer(modelsService)

    // Present exactly once, from localActive - not double-added by the
    // server-default branch.
    expect(useAppState.getState().activeModels).toEqual(['qwen3-4b'])
  })

  it('does not add the server default when its provider cannot be resolved', async () => {
    useModelProvider.setState({ providers: [] })
    useLocalApiServer.setState({
      defaultModelLocalApiServer: { model: 'ghost', provider: 'ghost-provider' },
    })
    const modelsService = {
      getActiveModels: vi.fn().mockResolvedValue([]),
    }

    await hydrateActiveModelsForRunningServer(modelsService)

    expect(useAppState.getState().activeModels).toEqual([])
  })

  it('combines local models and the cloud default without duplicates', async () => {
    const cloudProvider = makeProvider('openai', [{ id: 'gpt-5.4' }], {
      api_key: 'sk-test',
    })
    useModelProvider.setState({ providers: [cloudProvider] })
    useLocalApiServer.setState({
      defaultModelLocalApiServer: { model: 'gpt-5.4', provider: 'openai' },
    })
    const modelsService = {
      getActiveModels: vi.fn().mockResolvedValue(['qwen3-4b']),
    }

    await hydrateActiveModelsForRunningServer(modelsService)

    expect(useAppState.getState().activeModels.sort()).toEqual(
      ['gpt-5.4', 'qwen3-4b'].sort()
    )
  })
})
