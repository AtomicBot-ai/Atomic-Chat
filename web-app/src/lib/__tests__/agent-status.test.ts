import { beforeEach, describe, expect, it } from 'vitest'

import { INTEGRATION_AGENTS } from '@/constants/integrations'
import { useApiServerLog } from '@/hooks/useApiServerLog'
import { useAppState } from '@/hooks/useAppState'
import { useLaunchStore } from '@/stores/launch-store'
import type { ApiRequestEntry } from '@/types/apiServerLog'

import {
  agentsWithRequests,
  deriveAgentState,
  type AgentFacts,
} from '../agent-status'

const agent = (id: string) => INTEGRATION_AGENTS.find((a) => a.id === id)!

let seq = 0
function request(
  at: number,
  endpoint: string,
  model: string | null,
  extra: Partial<ApiRequestEntry> = {}
): ApiRequestEntry {
  seq += 1
  return {
    kind: 'request',
    id: `r${seq}`,
    seq,
    startedAt: at,
    status: 'completed',
    method: 'POST',
    endpoint,
    model,
    stream: true,
    ...extra,
  }
}

describe('deriveAgentState', () => {
  const facts = (over: Partial<AgentFacts>): AgentFacts => ({
    installed: true,
    configured: true,
    opened: false,
    connected: false,
    ...over,
  })

  it('goes Not installed → Installed → Configured → Opened → Connected', () => {
    const codex = agent('codex')
    expect(
      deriveAgentState(
        codex,
        facts({ installed: undefined, configured: false })
      )
    ).toBe('not_installed')
    expect(deriveAgentState(codex, facts({ configured: false }))).toBe(
      'installed'
    )
    expect(deriveAgentState(codex, facts({}))).toBe('configured')
    expect(deriveAgentState(codex, facts({ opened: true }))).toBe('opened')
    expect(
      deriveAgentState(codex, facts({ opened: true, connected: true }))
    ).toBe('connected')
  })

  it('does not call a config with no program to read it ready', () => {
    // An agent Atomic Chat installs goes back to Install.
    expect(
      deriveAgentState(
        agent('codex'),
        facts({ installed: false, opened: true })
      )
    ).toBe('not_installed')
    // ZCode is installed from its own site: the app is missing.
    expect(deriveAgentState(agent('zcode'), facts({ installed: false }))).toBe(
      'app_missing'
    )
    // Not detected yet is not missing.
    expect(
      deriveAgentState(agent('zcode'), facts({ installed: undefined }))
    ).toBe('configured')
  })

  it('keeps an editor set up by hand as configured', () => {
    expect(deriveAgentState(agent('vscode'), facts({ installed: false }))).toBe(
      'configured'
    )
  })
})

describe('agentsWithRequests', () => {
  it('credits a request to the agent whose endpoint and model it carries', () => {
    const opened = {
      'claude-code': { at: 100, model: 'qwen' },
      'codex': { at: 100, model: 'qwen' },
      'kilo': { at: 100, model: 'qwen' },
    }
    // Claude Code may ask for its own side model on /v1/messages.
    expect(
      agentsWithRequests(opened, [request(200, 'messages', 'claude-haiku')])
    ).toEqual(new Set(['claude-code']))
    expect(
      agentsWithRequests(opened, [request(200, 'responses', 'qwen')])
    ).toEqual(new Set(['codex']))
    expect(
      agentsWithRequests(opened, [request(200, 'chat/completions', 'qwen')])
    ).toEqual(new Set(['kilo']))
    // Another model, or a listing, is nobody's.
    expect(
      agentsWithRequests(opened, [
        request(200, 'chat/completions', 'gemma'),
        request(200, 'models', null),
      ])
    ).toEqual(new Set())
  })

  it('ignores what came before the agent was opened, and requests the server refused', () => {
    const opened = { kilo: { at: 100, model: 'qwen' } }
    expect(
      agentsWithRequests(opened, [
        request(99, 'chat/completions', 'qwen'),
        request(150, 'chat/completions', 'qwen', {
          status: 'error',
          httpStatus: 401,
        }),
      ])
    ).toEqual(new Set())
    // A server-side failure still means the agent reached it.
    expect(
      agentsWithRequests(opened, [
        request(150, 'chat/completions', 'qwen', {
          status: 'error',
          httpStatus: 503,
        }),
      ])
    ).toEqual(new Set(['kilo']))
  })

  it('credits the agent opened most recently before the request', () => {
    const opened = {
      kilo: { at: 100, model: 'qwen' },
      opencode: { at: 300, model: 'qwen' },
    }
    expect(
      agentsWithRequests(opened, [request(200, 'chat/completions', 'qwen')])
    ).toEqual(new Set(['kilo']))
    expect(
      agentsWithRequests(opened, [request(400, 'chat/completions', 'qwen')])
    ).toEqual(new Set(['opencode']))
  })
})

describe('the launch store hears from opened agents', () => {
  beforeEach(() => {
    useAppState.setState({ serverStatus: 'running' })
    useLaunchStore.setState({ opened: {}, connected: {} })
    useApiServerLog.getState().reset()
  })

  const arrive = (entry: ApiRequestEntry) =>
    useApiServerLog.getState().applyBatch([{ t: 'start', entry }])

  it('marks an agent connected on its first request, and keeps it so', () => {
    useLaunchStore.getState().markOpened('codex', 'qwen')
    const at = useLaunchStore.getState().opened.codex.at

    arrive(request(at + 10, 'chat/completions', 'qwen'))
    expect(useLaunchStore.getState().connected).toEqual({ codex: false })

    arrive(request(at + 20, 'responses', 'qwen'))
    expect(useLaunchStore.getState().connected).toEqual({ codex: true })

    // Clearing the Activity log does not take it back.
    useApiServerLog.getState().clear()
    expect(useLaunchStore.getState().connected).toEqual({ codex: true })
  })

  it('forgets what it opened when the server stops', () => {
    useLaunchStore.getState().markOpened('kilo', 'qwen')
    arrive(
      request(
        useLaunchStore.getState().opened.kilo.at,
        'chat/completions',
        'qwen'
      )
    )
    expect(useLaunchStore.getState().connected).toEqual({ kilo: true })

    useAppState.setState({ serverStatus: 'stopped' })

    expect(useLaunchStore.getState()).toMatchObject({
      opened: {},
      connected: {},
    })
  })
})
