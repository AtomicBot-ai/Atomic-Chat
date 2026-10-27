import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { INTEGRATION_AGENTS } from '@/constants/integrations'

import {
  agentApiUrl,
  agentConfiguredDescriptionKey,
  agentConnectHost,
  isGuidedAgent,
  writeAgentConfig,
} from '../integration-agent-setup'

const agent = (id: string) => INTEGRATION_AGENTS.find((a) => a.id === id)!

const SERVER = {
  serverHost: '0.0.0.0',
  serverPort: 1337,
  apiPrefix: '/v1',
  apiKey: 'sk-atomic-key',
}

describe('integration agent setup', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
  })

  it('dials loopback when the server listens on every interface', () => {
    expect(agentConnectHost('0.0.0.0')).toBe('127.0.0.1')
    expect(agentConnectHost('::')).toBe('127.0.0.1')
    expect(agentConnectHost('127.0.0.1')).toBe('127.0.0.1')
  })

  it('adds the API prefix only for agents that want it', () => {
    expect(agentApiUrl(agent('codex'), SERVER)).toBe('http://127.0.0.1:1337/v1')
    // Claude Code appends its own path to the bare host.
    expect(agentApiUrl(agent('claude-code'), SERVER)).toBe(
      'http://127.0.0.1:1337'
    )
  })

  it('writes the agent config with the URL, the model and the key', async () => {
    await expect(
      writeAgentConfig(agent('codex'), 'qwen3.5-4b', SERVER)
    ).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('configure_codex', {
      apiUrl: 'http://127.0.0.1:1337/v1',
      model: 'qwen3.5-4b',
      apiKey: 'sk-atomic-key',
    })
  })

  it('leaves the key out when the server has none, and keeps Hermes at its 64K floor', async () => {
    await expect(
      writeAgentConfig(agent('hermes'), 'gemma-4', { ...SERVER, apiKey: '' })
    ).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('configure_hermes_agent', {
      apiUrl: 'http://127.0.0.1:1337/v1',
      model: 'gemma-4',
      apiKey: undefined,
      contextLength: 65536,
    })
  })

  it('refuses an agent it does not know', async () => {
    await expect(
      writeAgentConfig({ ...agent('codex'), id: 'unknown' }, null, SERVER)
    ).rejects.toThrow('Unknown agent: unknown')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('guides the agents it configures and leaves the hand-set editors out', () => {
    expect(isGuidedAgent(agent('codex'))).toBe(true)
    expect(isGuidedAgent(agent('vscode'))).toBe(false)
  })

  it('tells the agents that pick a config up live apart in the toast', () => {
    expect(agentConfiguredDescriptionKey('openclaw')).toBe(
      'launch:toast.configuredDescOpenclaw'
    )
    expect(agentConfiguredDescriptionKey('codex')).toBe(
      'launch:toast.configuredDescCodex'
    )
    expect(agentConfiguredDescriptionKey('opencode')).toBe(
      'launch:toast.configuredDesc'
    )
  })
})
