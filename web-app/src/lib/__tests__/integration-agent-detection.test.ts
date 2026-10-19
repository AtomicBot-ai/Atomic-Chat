import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { INTEGRATION_AGENTS } from '@/constants/integrations'
import { useLaunchStore } from '@/stores/launch-store'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const agent = INTEGRATION_AGENTS[0]

describe('detectIntegrationAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useLaunchStore.setState({ installed: {}, viaWsl: {}, binPath: {} })
  })

  it('records what the shell reports', async () => {
    vi.mocked(invoke).mockResolvedValue({
      installed: true,
      viaWsl: true,
      path: '/opt/bin/agent',
    })
    const { detectIntegrationAgent } = await import(
      '../integration-agent-detection'
    )

    await expect(detectIntegrationAgent(agent, '/custom')).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('detect_agent_installed', {
      bin: agent.detectBin,
      customPath: '/custom',
    })
    const state = useLaunchStore.getState()
    expect(state.installed[agent.id]).toBe(true)
    expect(state.viaWsl[agent.id]).toBe(true)
    expect(state.binPath[agent.id]).toBe('/opt/bin/agent')
  })

  it('records "not installed" when the shell cannot answer', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('no shell'))
    const { detectIntegrationAgent } = await import(
      '../integration-agent-detection'
    )

    await expect(detectIntegrationAgent(agent)).resolves.toBe(false)
    expect(useLaunchStore.getState().installed[agent.id]).toBe(false)
  })
})

describe('detectIntegrationAgentsOnce', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.mocked(invoke).mockResolvedValue({ installed: false, viaWsl: false })
  })

  it('asks once per session, and only about agents not yet known', async () => {
    // Fresh modules: the session flag and the store both start over, and
    // the store must be the instance the detection module sees.
    const { useLaunchStore: store } = await import('@/stores/launch-store')
    store.setState({ installed: { [agent.id]: true } })
    const { detectIntegrationAgentsOnce } = await import(
      '../integration-agent-detection'
    )

    detectIntegrationAgentsOnce()
    detectIntegrationAgentsOnce()

    expect(invoke).toHaveBeenCalledTimes(INTEGRATION_AGENTS.length - 1)
    // The known answer stands; it is not asked again.
    expect(store.getState().installed[agent.id]).toBe(true)
    expect(invoke).not.toHaveBeenCalledWith(
      'detect_agent_installed',
      expect.objectContaining({ bin: agent.detectBin })
    )
  })
})
