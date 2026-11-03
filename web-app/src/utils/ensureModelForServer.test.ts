import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useModelProvider } from '@/hooks/useModelProvider'

import { EMBEDDING_MODEL_ID } from '@/constants/models'

import {
  ensureModelForServer,
  findServingProvider,
  resolveServerModels,
} from './ensureModelForServer'

/** A provider that lists `ids`; both llama.cpp providers list the same models folder. */
const provider = (name: string, ids: string[], active = true) =>
  ({
    provider: name,
    active,
    models: ids.map((id) => ({ id })),
  }) as unknown as ModelProvider

/** A models service whose engines each report only their own sessions. */
const engines = (sessions: Record<string, string[]>) => ({
  getActiveModels: vi.fn(async (name?: string) =>
    name === undefined
      ? [...new Set(Object.values(sessions).flat())]
      : (sessions[name] ?? [])
  ),
})

describe('the provider that serves a loaded model', () => {
  beforeEach(() => {
    // TurboQuant is listed first, as it is on a real install.
    useModelProvider.setState({
      providers: [
        provider('llamacpp', ['qwen']),
        provider('llamacpp-upstream', ['qwen']),
        provider('openai', ['gpt-5']),
      ],
    })
  })

  it('is the one whose engine holds the session, not the first that owns the id', async () => {
    const served = await findServingProvider(
      'qwen',
      engines({ 'llamacpp-upstream': ['qwen'] })
    )

    expect(served?.provider).toBe('llamacpp-upstream')
  })

  it('beats the server default when the other engine is the one running it', async () => {
    const served = await findServingProvider(
      'qwen',
      engines({ llamacpp: ['qwen'] }),
      'llamacpp-upstream'
    )

    expect(served?.provider).toBe('llamacpp')
  })

  it('is the server default when both engines hold the model', async () => {
    const served = await findServingProvider(
      'qwen',
      engines({ 'llamacpp': ['qwen'], 'llamacpp-upstream': ['qwen'] }),
      'llamacpp-upstream'
    )

    expect(served?.provider).toBe('llamacpp-upstream')
  })

  it('falls back to the server default, then to an active owner, when no engine claims it', async () => {
    const nobody = engines({})

    expect(
      (await findServingProvider('qwen', nobody, 'llamacpp-upstream'))?.provider
    ).toBe('llamacpp-upstream')

    useModelProvider.setState({
      providers: [
        provider('llamacpp', ['qwen'], false),
        provider('llamacpp-upstream', ['qwen']),
      ],
    })
    expect((await findServingProvider('qwen', nobody))?.provider).toBe(
      'llamacpp-upstream'
    )
  })

  it('pairs each loaded id with its engine and leaves out ids no provider lists', async () => {
    const service = engines({ 'llamacpp-upstream': ['qwen', 'deleted.gguf'] })

    await expect(
      resolveServerModels(['qwen', 'deleted.gguf'], service)
    ).resolves.toEqual([{ model: 'qwen', provider: 'llamacpp-upstream' }])
  })
})

describe('the chat model the server already has', () => {
  beforeEach(() => {
    localStorage.clear()
    useModelProvider.setState({
      selectedModel: null,
      selectedProvider: null,
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [{ id: EMBEDDING_MODEL_ID, embedding: true }, { id: 'qwen' }],
        } as unknown as ModelProvider,
      ],
    })
  })

  const service = (loaded: string[]) => ({
    getActiveModels: vi.fn(async () => loaded),
    stopModel: vi.fn(async () => undefined),
    startModel: vi.fn(async () => undefined),
  })

  it('is never the embedding session project indexing loaded: a chat model is started instead', async () => {
    const models = service([EMBEDDING_MODEL_ID])

    const result = await ensureModelForServer({ modelsService: models })

    expect(result).toEqual({
      status: 'loaded',
      modelId: 'qwen',
      providerName: 'llamacpp-upstream',
    })
    expect(models.startModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'llamacpp-upstream' }),
      'qwen',
      true
    )
  })

  it('is a loaded chat model even when the embedding session is listed first', async () => {
    const models = service([EMBEDDING_MODEL_ID, 'qwen'])

    await expect(
      ensureModelForServer({ modelsService: models })
    ).resolves.toEqual({
      status: 'already_loaded',
      modelId: 'qwen',
      providerName: 'llamacpp-upstream',
    })
    expect(models.startModel).not.toHaveBeenCalled()
  })
})
