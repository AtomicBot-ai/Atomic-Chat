import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { INTEGRATION_AGENTS } from '@/constants/integrations'
import { useServerSetup } from '@/hooks/useServerSetup'
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

describe('adoptConfiguredAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useServerSetup.setState({ configuredAgents: [], forgottenAgents: [] })
  })

  it('lists the known agents whose config already points here', async () => {
    vi.mocked(invoke).mockResolvedValue(['opencode', 'not-an-agent'])
    const { adoptConfiguredAgents } = await import(
      '../integration-agent-detection'
    )

    await adoptConfiguredAgents()

    expect(invoke).toHaveBeenCalledWith('detect_configured_agents')
    expect(
      useServerSetup.getState().configuredAgents.map((entry) => entry.id)
    ).toEqual(['opencode'])
  })

  it('leaves the list as it is when the backend cannot tell', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('unknown command'))
    const { adoptConfiguredAgents } = await import(
      '../integration-agent-detection'
    )

    await expect(adoptConfiguredAgents()).resolves.toBeUndefined()
    expect(useServerSetup.getState().configuredAgents).toEqual([])
  })
})

describe('detectIntegrationAgentsOnce', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === 'detect_configured_agents'
        ? []
        : { installed: false, viaWsl: false }
    )
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

    // One question per unknown agent, plus one for what is already set up.
    expect(invoke).toHaveBeenCalledTimes(INTEGRATION_AGENTS.length)
    expect(invoke).toHaveBeenCalledWith('detect_configured_agents')
    // The known answer stands; it is not asked again.
    expect(store.getState().installed[agent.id]).toBe(true)
    expect(invoke).not.toHaveBeenCalledWith(
      'detect_agent_installed',
      expect.objectContaining({ bin: agent.detectBin })
    )
  })
})
