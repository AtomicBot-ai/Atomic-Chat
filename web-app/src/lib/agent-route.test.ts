import { describe, expect, it } from 'vitest'
import { resolveMessageExecutionRoute } from '@/lib/agent-route'

describe('resolveMessageExecutionRoute', () => {
  it('routes Agent threads to direct IPC', () => {
    expect(resolveMessageExecutionRoute(true)).toBe('agent-ipc')
  })

  it('keeps Chat threads on the AI SDK transport', () => {
    expect(resolveMessageExecutionRoute(false)).toBe('chat-transport')
  })
})
