import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  setRunning,
  mediaResident,
  embeddingResident,
  stopAllByUser,
  syncActive,
  unloadMedia,
  stopEmbedding,
  stopDecision,
} = vi.hoisted(() => ({
  setRunning: vi.fn(),
  mediaResident: vi.fn(),
  embeddingResident: vi.fn(),
  stopAllByUser: vi.fn(),
  syncActive: vi.fn(),
  unloadMedia: vi.fn(),
  stopEmbedding: vi.fn(),
  stopDecision: vi.fn(),
}))

vi.mock('@/utils/localApiServerControl', () => ({
  setLocalApiServerRunning: setRunning,
  hasResidentMediaModel: mediaResident,
  hasResidentEmbeddingModel: embeddingResident,
}))
vi.mock('@/utils/switchModel', () => ({
  stopAllLocalModelsByUser: stopAllByUser,
}))
vi.mock('@/utils/activeModelsSync', () => ({
  syncActiveModelsFromEngines: syncActive,
}))
vi.mock('@/stores/image-generation-store', () => ({
  useImageGenerationStore: { getState: () => ({ unloadModel: unloadMedia }) },
}))
vi.mock('@/lib/embedding/models', () => ({ stopEmbeddingModel: stopEmbedding }))
vi.mock('@/lib/decision/models', () => ({ stopDecisionModel: stopDecision }))

import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import type { ServiceHub } from '@/services'

import {
  resumeServedHelperModels,
  turnOffLocalApiServer,
} from '../turnOffLocalApiServer'

/** A core service whose config the test reads back. */
const helperService = (enabled: boolean, modelPath = 'models/x.gguf') => {
  const config = { enabled, model_path: modelPath }
  return {
    config,
    isSupported: () => true,
    getStatus: vi.fn(async () => ({ enabled: config.enabled })),
    getConfig: vi.fn(async () => ({ config })),
    setConfig: vi.fn(async (patch: Partial<typeof config>) => {
      Object.assign(config, patch)
      return { config }
    }),
  }
}

describe('turning the Local API Server off', () => {
  let embedding: ReturnType<typeof helperService>
  let decision: ReturnType<typeof helperService>
  let hub: ServiceHub

  beforeEach(() => {
    vi.clearAllMocks()
    useLocalApiServer.setState({ pausedHelperModels: [] })
    setRunning.mockResolvedValue(undefined)
    stopAllByUser.mockResolvedValue(undefined)
    unloadMedia.mockResolvedValue(undefined)
    mediaResident.mockResolvedValue(false)
    embeddingResident.mockResolvedValue(false)
    embedding = helperService(false)
    decision = helperService(false)
    stopEmbedding.mockImplementation(async () => {
      embedding.config.enabled = false
    })
    stopDecision.mockImplementation(async () => {
      decision.config.enabled = false
    })
    hub = {
      diffusion: () => ({}),
      embedding: () => embedding,
      decision: () => decision,
    } as unknown as ServiceHub
  })

  it('stops the server first, then unloads the chat models as a user stop', async () => {
    await turnOffLocalApiServer(hub)

    expect(setRunning).toHaveBeenCalledWith(false)
    expect(stopAllByUser).toHaveBeenCalledWith(hub)
    expect(setRunning.mock.invocationCallOrder[0]).toBeLessThan(
      stopAllByUser.mock.invocationCallOrder[0]
    )
    // Cloud models keep their place; the local ones are gone.
    expect(syncActive).toHaveBeenCalledWith([])
  })

  it('unloads an image or video model and switches the embedding and decision models off', async () => {
    mediaResident.mockResolvedValue(true)
    embeddingResident.mockResolvedValue(true)
    embedding.config.enabled = true
    decision.config.enabled = true

    await turnOffLocalApiServer(hub)

    expect(unloadMedia).toHaveBeenCalledTimes(1)
    expect(stopEmbedding).toHaveBeenCalledTimes(1)
    expect(stopDecision).toHaveBeenCalledTimes(1)
    expect(useLocalApiServer.getState().pausedHelperModels).toEqual([
      'embedding',
      'decision',
    ])
  })

  it('leaves alone what was not running', async () => {
    await turnOffLocalApiServer(hub)

    expect(unloadMedia).not.toHaveBeenCalled()
    expect(stopEmbedding).not.toHaveBeenCalled()
    expect(stopDecision).not.toHaveBeenCalled()
    expect(useLocalApiServer.getState().pausedHelperModels).toEqual([])
  })

  it('still lets the other models go when one will not', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stopAllByUser.mockRejectedValue(new Error('engine busy'))
    decision.config.enabled = true

    await turnOffLocalApiServer(hub)

    expect(stopDecision).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      '[LocalAPI] could not unload the chat model:',
      expect.any(Error)
    )
    warn.mockRestore()
  })

  it('keeps every model when the server would not stop', async () => {
    setRunning.mockRejectedValue(new Error('no core'))

    await expect(turnOffLocalApiServer(hub)).rejects.toThrow('no core')
    expect(stopAllByUser).not.toHaveBeenCalled()
  })

  it('switches the paused models back on once the server is up, and only once', async () => {
    useLocalApiServer.setState({
      pausedHelperModels: ['embedding', 'decision'],
    })

    await resumeServedHelperModels(hub)

    expect(embedding.setConfig).toHaveBeenCalledWith({ enabled: true })
    expect(decision.setConfig).toHaveBeenCalledWith({ enabled: true })
    expect(useLocalApiServer.getState().pausedHelperModels).toEqual([])

    await resumeServedHelperModels(hub)
    expect(embedding.setConfig).toHaveBeenCalledTimes(1)
  })

  it('does not switch on a model removed while the server was off', async () => {
    embedding = helperService(false, '')
    useLocalApiServer.setState({ pausedHelperModels: ['embedding'] })

    await resumeServedHelperModels(hub)

    expect(embedding.setConfig).not.toHaveBeenCalled()
  })
})
