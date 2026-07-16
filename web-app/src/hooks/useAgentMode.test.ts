import { beforeEach, describe, expect, it } from 'vitest'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useAgentMode } from '@/hooks/useAgentMode'

describe('useAgentMode', () => {
  beforeEach(() => {
    useAgentMode.getState().clearAll()
  })

  it('moves the Home selection to the created thread', () => {
    useAgentMode.getState().setAgentMode(TEMPORARY_CHAT_ID, true)

    useAgentMode.getState().transferAgentMode(TEMPORARY_CHAT_ID, 'thread-1')

    expect(useAgentMode.getState().isAgentMode('thread-1')).toBe(true)
    expect(useAgentMode.getState().isAgentMode(TEMPORARY_CHAT_ID)).toBe(false)
  })

  it('keeps a newly created Chat thread out of the agent map', () => {
    useAgentMode.getState().transferAgentMode(TEMPORARY_CHAT_ID, 'thread-1')

    expect(useAgentMode.getState().isAgentMode('thread-1')).toBe(false)
  })
})
