import { beforeEach, describe, expect, it } from 'vitest'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { localStorageKey } from '@/constants/localStorage'
import { useAgentMode } from '@/hooks/useAgentMode'

describe('useAgentMode', () => {
  beforeEach(() => {
    useAgentMode.getState().clearAll()
  })

  it('moves the Home selection to the created thread', () => {
    useAgentMode.getState().setAgentMode(TEMPORARY_CHAT_ID, true)
    useAgentMode.getState().setApprovalMode(TEMPORARY_CHAT_ID, 'skip')
    useAgentMode.getState().setWorkingDir(TEMPORARY_CHAT_ID, '/workspace')

    useAgentMode.getState().transferAgentMode(TEMPORARY_CHAT_ID, 'thread-1')

    expect(useAgentMode.getState().isAgentMode('thread-1')).toBe(true)
    expect(useAgentMode.getState().getApprovalMode('thread-1')).toBe('skip')
    expect(useAgentMode.getState().getWorkingDir('thread-1')).toBe('/workspace')
    expect(useAgentMode.getState().isAgentMode(TEMPORARY_CHAT_ID)).toBe(false)
    expect(useAgentMode.getState().getApprovalMode(TEMPORARY_CHAT_ID)).toBe(
      'manual'
    )
    expect(useAgentMode.getState().getWorkingDir(TEMPORARY_CHAT_ID)).toBe(
      undefined
    )
  })

  it('keeps a newly created Chat thread out of the agent map', () => {
    useAgentMode.getState().transferAgentMode(TEMPORARY_CHAT_ID, 'thread-1')

    expect(useAgentMode.getState().isAgentMode('thread-1')).toBe(false)
    expect(useAgentMode.getState().getApprovalMode('thread-1')).toBe('manual')
  })

  it('persists the selected sidebar mode', () => {
    useAgentMode.getState().setSidebarMode('agent')

    expect(useAgentMode.getState().sidebarMode).toBe('agent')
    expect(
      JSON.parse(localStorage.getItem(localStorageKey.agentMode) ?? '{}').state
        .sidebarMode
    ).toBe('agent')
  })

  it('resets the sidebar mode with the Agent state', () => {
    useAgentMode.getState().setSidebarMode('agent')

    useAgentMode.getState().clearAll()

    expect(useAgentMode.getState().sidebarMode).toBe('chat')
  })
})
