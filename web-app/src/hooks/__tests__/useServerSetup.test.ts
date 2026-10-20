import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useLocalApiServer } from '@/hooks/useLocalApiServer'

import {
  useServerSetup,
  useSetupDone,
  useSetupGuideVisible,
} from '../useServerSetup'

const setup = () => useServerSetup.getState()

describe('useServerSetup', () => {
  beforeEach(() => {
    localStorage.clear()
    useLocalApiServer.setState({ lastServerModels: [] })
    useServerSetup.setState({
      setupDone: false,
      setupDismissed: false,
      configuredAgents: [],
      forgottenAgents: [],
      endpointConfigured: false,
      guide: null,
      guideRevision: 0,
      guideActive: false,
    })
  })

  it('shows the guide on a first visit, and not once it was closed', () => {
    const { result } = renderHook(() => useSetupGuideVisible())
    expect(result.current).toBe(true)

    act(() => setup().closeGuide())

    expect(result.current).toBe(false)
    expect(setup().setupDismissed).toBe(true)
  })

  it('counts a server that already served a model as set up', () => {
    const { result } = renderHook(() => ({
      done: useSetupDone(),
      visible: useSetupGuideVisible(),
    }))
    expect(result.current.done).toBe(false)

    act(() =>
      useLocalApiServer.setState({
        lastServerModels: [{ model: 'qwen', provider: 'llamacpp-upstream' }],
      })
    )

    expect(result.current).toEqual({ done: true, visible: false })
  })

  it('opens afresh at a given step each time it is asked for', () => {
    setup().openGuide({ path: 'agent', agentId: 'codex' })
    expect(setup()).toMatchObject({
      guide: { path: 'agent', agentId: 'codex' },
      guideRevision: 1,
      guideActive: true,
    })

    setup().openGuide()
    expect(setup()).toMatchObject({
      guide: { path: 'choose' },
      guideRevision: 2,
    })
  })

  it('stays open through to its success screen once shown', () => {
    const { result } = renderHook(() => useSetupGuideVisible())
    act(() => setup().holdGuide())
    act(() => setup().finishSetup())

    expect(result.current).toBe(true)

    act(() => setup().closeGuide())
    expect(result.current).toBe(false)
    // Closing after the guide finished is not a dismissal.
    expect(setup().setupDismissed).toBe(false)
  })

  it('keeps one entry per tool, newest last, and forgets on request', () => {
    setup().markAgentConfigured('codex')
    setup().markAgentConfigured('claude-code')
    setup().markAgentConfigured('codex')
    expect(setup().configuredAgents.map((agent) => agent.id)).toEqual([
      'claude-code',
      'codex',
    ])

    setup().forgetAgent('claude-code')
    setup().markEndpointConfigured()
    expect(setup().configuredAgents.map((agent) => agent.id)).toEqual(['codex'])
    expect(setup().endpointConfigured).toBe(true)

    setup().forgetEndpoint()
    expect(setup().endpointConfigured).toBe(false)
  })

  it('adopts tools found set up before, but not ones the user removed', () => {
    setup().markAgentConfigured('codex')
    setup().markAgentConfigured('pi')
    setup().forgetAgent('pi')

    setup().adoptAgents(['opencode', 'codex', 'pi', 'opencode'])

    // Found ones read as older than what the guide set up.
    expect(setup().configuredAgents.map((agent) => agent.id)).toEqual([
      'opencode',
      'codex',
    ])

    // Setting one up again lets detection see it from then on.
    setup().markAgentConfigured('pi')
    setup().forgetAgent('opencode')
    expect(setup().forgottenAgents).toEqual(['opencode'])
  })

  it('persists what was set up, never the guide on screen', () => {
    setup().markAgentConfigured('codex')
    setup().openGuide({ path: 'endpoint' })
    setup().finishSetup()

    const stored = JSON.parse(localStorage.getItem('atomic-server-setup')!)
    expect(Object.keys(stored.state).sort()).toEqual([
      'configuredAgents',
      'endpointConfigured',
      'forgottenAgents',
      'setupDismissed',
      'setupDone',
    ])
    expect(stored.state.setupDone).toBe(true)
  })
})
