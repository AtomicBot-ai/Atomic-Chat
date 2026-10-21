import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useModelProvider } from '@/hooks/useModelProvider'

import {
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
