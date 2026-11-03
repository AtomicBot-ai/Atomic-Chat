import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ensureModelForServer, resolveServerModels } = vi.hoisted(() => ({
  ensureModelForServer: vi.fn(),
  resolveServerModels: vi.fn(),
}))

vi.mock('@/utils/ensureModelForServer', () => ({
  ensureModelForServer,
  resolveServerModels,
}))

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import { EMBEDDING_MODEL_ID } from '@/constants/models'

import {
  canLoadForServer,
  ensureServedModelRunning,
  loadServedModel,
  servedModel,
  servedModelId,
} from '../servedModel'

const QWEN = { model: 'qwen', provider: 'llamacpp-upstream' }
const GEMMA = { model: 'gemma', provider: 'llamacpp-upstream' }

const provider = (name: string, ids: string[], active = true) =>
  ({
    provider: name,
    active,
    models: ids.map((id) => ({ id })),
  }) as unknown as ModelProvider

/** A models service whose engines report `running` until a load adds to it. */
const engines = (running: string[]) => ({
  getActiveModels: vi.fn(async () => [...running]),
  stopModel: vi.fn(),
  startModel: vi.fn(),
})

describe('the served model', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useLocalApiServer.setState({
      lastServerModels: [],
      defaultModelLocalApiServer: null,
    })
    useModelProvider.setState({
      providers: [
        provider('llamacpp-upstream', ['qwen', 'gemma', EMBEDDING_MODEL_ID]),
        provider('mlx', ['mlx-model'], false),
        provider('openai', ['gpt-5']),
      ],
    })
    useAppState.setState({ activeModels: [] })
  })

  it('is the one the server serves now, else the one it will start with', () => {
    expect(servedModel()).toBeNull()
    expect(servedModelId()).toBeNull()

    useLocalApiServer.setState({ defaultModelLocalApiServer: GEMMA })
    expect(servedModel()).toEqual(GEMMA)

    useLocalApiServer.setState({ lastServerModels: [QWEN] })
    expect(servedModel()).toEqual(QWEN)
    expect(servedModelId()).toBe('qwen')
  })

  it('has something to load only for a chat model a switched-on local engine lists', () => {
    expect(canLoadForServer(QWEN)).toBe(true)
    // A cloud model loads nothing; a deleted one must not let another load.
    expect(canLoadForServer({ model: 'gpt-5', provider: 'openai' })).toBe(false)
    expect(
      canLoadForServer({ model: 'deleted', provider: 'llamacpp-upstream' })
    ).toBe(false)
    expect(canLoadForServer({ model: 'mlx-model', provider: 'mlx' })).toBe(
      false
    )
    expect(
      canLoadForServer({
        model: EMBEDDING_MODEL_ID,
        provider: 'llamacpp-upstream',
      })
    ).toBe(false)
  })

  it('loads as Start does, and records what the server serves', async () => {
    const service = engines(['qwen'])
    ensureModelForServer.mockResolvedValue({
      status: 'loaded',
      modelId: 'qwen',
      providerName: 'llamacpp-upstream',
    })
    resolveServerModels.mockResolvedValue([QWEN])

    await expect(loadServedModel(service, QWEN)).resolves.toMatchObject({
      status: 'loaded',
    })

    expect(ensureModelForServer).toHaveBeenCalledWith({
      modelsService: service,
      modelOverride: QWEN,
    })
    expect(resolveServerModels).toHaveBeenCalledWith(
      ['qwen'],
      service,
      'llamacpp-upstream'
    )
    expect(useLocalApiServer.getState().lastServerModels).toEqual([QWEN])
    expect(useAppState.getState().activeModels).toEqual(['qwen'])
  })

  describe('before an agent is pointed at it', () => {
    it('loads the served model a running server does not hold', async () => {
      useLocalApiServer.setState({ lastServerModels: [QWEN] })
      const running: string[] = []
      const service = engines(running)
      ensureModelForServer.mockImplementation(async () => {
        running.push('qwen')
        return {
          status: 'loaded',
          modelId: 'qwen',
          providerName: 'llamacpp-upstream',
        }
      })
      resolveServerModels.mockResolvedValue([QWEN])

      await ensureServedModelRunning(service)

      expect(ensureModelForServer).toHaveBeenCalledWith(
        expect.objectContaining({ modelOverride: QWEN })
      )
      expect(useAppState.getState().activeModels).toEqual(['qwen'])
    })

    it('leaves a model that runs, a cloud model and no model alone', async () => {
      useLocalApiServer.setState({ lastServerModels: [QWEN] })
      await ensureServedModelRunning(engines(['qwen']))

      useLocalApiServer.setState({
        lastServerModels: [{ model: 'gpt-5', provider: 'openai' }],
      })
      await ensureServedModelRunning(engines([]))

      useLocalApiServer.setState({ lastServerModels: [] })
      await ensureServedModelRunning(engines([]))

      expect(ensureModelForServer).not.toHaveBeenCalled()
      expect(useAppState.getState().activeModels).toEqual([])
    })

    it('fails when there turns out to be nothing to load', async () => {
      useLocalApiServer.setState({ lastServerModels: [QWEN] })
      ensureModelForServer.mockResolvedValue({ status: 'no_model_available' })

      await expect(ensureServedModelRunning(engines([]))).rejects.toThrow(
        'No model available to load'
      )
    })
  })
})
