import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { writeAgentConfig, toastInfo } = vi.hoisted(() => ({
  writeAgentConfig: vi.fn(),
  toastInfo: vi.fn(),
}))

// Nothing here may reach a real agent's config.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/integration-agent-setup', () => ({ writeAgentConfig }))
vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

import { EMBEDDING_MODEL_ID } from '@/constants/models'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServerSetup } from '@/hooks/useServerSetup'

import {
  pointConnectedAgentsAt,
  syncConnectedAgentsWithServedModel,
} from '../connectedAgentsModel'

const QWEN = { model: 'qwen3.5-4b', provider: 'llamacpp-upstream' }
const GEMMA = {
  model: 'unsloth/gemma-4-e4b-it-GGUF',
  provider: 'llamacpp-upstream',
}

/** Let the queued writes run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const writtenAgents = () =>
  writeAgentConfig.mock.calls.map(([agent, model]) => [agent.id, model])

describe('connected agents follow the served model', () => {
  let stop: () => void = () => {}

  beforeEach(() => {
    vi.clearAllMocks()
    writeAgentConfig.mockResolvedValue(undefined)
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [
            { id: QWEN.model },
            { id: GEMMA.model, displayName: 'Gemma 4 E4B' },
            { id: EMBEDDING_MODEL_ID },
          ],
        },
      ] as unknown as ModelProvider[],
    })
    useLocalApiServer.setState({
      serverHost: '0.0.0.0',
      serverPort: 1338,
      apiPrefix: '/v1',
      apiKey: 'local-key',
      lastServerModels: [QWEN],
      defaultModelLocalApiServer: QWEN,
    })
    // Codex and Claude Code connected; an id no longer in the catalog and an
    // editor set up by hand are skipped.
    useServerSetup.setState({
      configuredAgents: [
        { id: 'codex', at: 1 },
        { id: 'retired-agent', at: 2 },
        { id: 'vscode', at: 3 },
        { id: 'claude-code', at: 4 },
      ],
    })
  })

  afterEach(() => stop())

  it('points every connected agent at the new model, with the server settings, and says so once', async () => {
    stop = syncConnectedAgentsWithServedModel()
    // A chat switches to Gemma (what `switchModel` records).
    useLocalApiServer.getState().setDefaultModelLocalApiServer(GEMMA)
    useLocalApiServer.getState().setLastServerModels([GEMMA])
    await settle()

    expect(writtenAgents()).toEqual([
      ['codex', GEMMA.model],
      ['claude-code', GEMMA.model],
    ])
    expect(writeAgentConfig.mock.calls[0]?.[2]).toMatchObject({
      serverHost: '0.0.0.0',
      serverPort: 1338,
      apiPrefix: '/v1',
      apiKey: 'local-key',
    })
    expect(toastInfo).toHaveBeenCalledTimes(1)
    expect(toastInfo).toHaveBeenCalledWith(
      'Connected tools now use Gemma 4 E4B',
      expect.objectContaining({
        id: 'connected-agents-model',
        description: expect.stringContaining('Restart'),
      })
    )
  })

  it('writes nothing for the model the agents already use, an unrelated change, or a model it cannot serve to them', async () => {
    useLocalApiServer.setState({ defaultModelLocalApiServer: null })
    stop = syncConnectedAgentsWithServedModel()
    const server = useLocalApiServer.getState()
    // The same id on another engine, and an unrelated setting.
    server.setLastServerModels([{ model: QWEN.model, provider: 'llamacpp' }])
    server.setProxyTimeout(30)
    // No model at all, an id no provider lists, an embedding model.
    server.setLastServerModels([])
    server.setLastServerModels([
      { model: 'deleted', provider: 'llamacpp-upstream' },
    ])
    server.setLastServerModels([
      { model: EMBEDDING_MODEL_ID, provider: 'llamacpp-upstream' },
    ])
    await settle()

    expect(writtenAgents()).toEqual([])
    expect(toastInfo).not.toHaveBeenCalled()
  })

  it('leaves the agents on their local model when the chat switches to a cloud model', async () => {
    useModelProvider.setState({
      providers: [
        ...useModelProvider.getState().providers,
        { provider: 'openai', active: true, models: [{ id: 'gpt-5.2' }] },
      ] as unknown as ModelProvider[],
    })
    stop = syncConnectedAgentsWithServedModel()
    useLocalApiServer
      .getState()
      .setLastServerModels([{ model: 'gpt-5.2', provider: 'openai' }])
    await settle()

    expect(writtenAgents()).toEqual([])
    expect(toastInfo).not.toHaveBeenCalled()
  })

  it('writes once per model, and drops a write a newer change overtook', async () => {
    stop = syncConnectedAgentsWithServedModel()
    const server = useLocalApiServer.getState()
    server.setLastServerModels([GEMMA])
    server.setLastServerModels([QWEN])
    await settle()
    // Back where the agents already were: nothing to write.
    expect(writtenAgents()).toEqual([])

    server.setLastServerModels([GEMMA])
    server.setLastServerModels([{ ...GEMMA, provider: 'llamacpp' }])
    await settle()
    expect(writtenAgents()).toEqual([
      ['codex', GEMMA.model],
      ['claude-code', GEMMA.model],
    ])
    expect(toastInfo).toHaveBeenCalledTimes(1)
  })

  it('keeps going past an agent whose config cannot be written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeAgentConfig.mockRejectedValueOnce(new Error('permission denied'))

    const written = await pointConnectedAgentsAt(GEMMA.model)

    expect(written.map((agent) => agent.id)).toEqual(['claude-code'])
    expect(warn.mock.calls[0]?.[1]).toEqual(new Error('permission denied'))
    warn.mockRestore()
  })

  it('says nothing when no agent is connected, and stops on unsubscribe', async () => {
    useServerSetup.setState({ configuredAgents: [] })
    stop = syncConnectedAgentsWithServedModel()
    useLocalApiServer.getState().setLastServerModels([GEMMA])
    await settle()
    expect(writtenAgents()).toEqual([])
    expect(toastInfo).not.toHaveBeenCalled()

    useServerSetup.setState({ configuredAgents: [{ id: 'codex', at: 1 }] })
    stop()
    useLocalApiServer.getState().setLastServerModels([QWEN])
    await settle()
    expect(writtenAgents()).toEqual([])
  })
})
