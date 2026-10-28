import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'macos' }))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), warning: vi.fn(), success: vi.fn(), error: vi.fn() },
}))

import { INTEGRATION_AGENTS } from '@/constants/integrations'
import { useLaunchStore } from '@/stores/launch-store'

import { openIntegrationAgent } from '../integration-agent-run'

const agent = (id: string) => INTEGRATION_AGENTS.find((a) => a.id === id)!
const t = (key: string) => key
const server = {
  serverHost: '0.0.0.0',
  serverPort: 1337,
  apiPrefix: '/v1',
  apiKey: "it's-secret",
}

describe('openIntegrationAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(invoke).mockResolvedValue(undefined)
    useLaunchStore.setState({ launched: {}, binPath: {} })
  })

  it('runs a terminal agent and remembers it opened', async () => {
    const opened = await openIntegrationAgent(agent('codex'), {
      t,
      model: 'qwen3.5-4b',
      server,
    })

    expect(opened).toBe(true)
    expect(invoke).toHaveBeenCalledWith('open_agent_terminal', {
      command: `ATOMIC_CHAT_API_KEY='it'\\''s-secret' codex --profile atomic-chat`,
      proxy: undefined,
    })
    expect(useLaunchStore.getState().launched).toEqual({ codex: true })
  })

  it('opens a desktop agent in its own app, not a terminal', async () => {
    await openIntegrationAgent(agent('zed'), { t, model: null, server })

    expect(invoke).toHaveBeenCalledWith('launch_zed')
    expect(invoke).not.toHaveBeenCalledWith(
      'open_agent_terminal',
      expect.anything()
    )
    expect(useLaunchStore.getState().launched).toEqual({ zed: true })
  })

  it('warns instead of throwing when the terminal does not open', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('no terminal app'))

    const opened = await openIntegrationAgent(agent('opencode'), {
      t,
      model: null,
      server,
    })

    expect(opened).toBe(false)
    expect(toast.warning).toHaveBeenCalledWith('launch:toast.terminalFailed', {
      description: 'no terminal app',
    })
    expect(useLaunchStore.getState().launched).toEqual({})
  })
})
