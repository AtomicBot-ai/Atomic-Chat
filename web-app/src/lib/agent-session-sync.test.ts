import { describe, expect, it } from 'vitest'
import { ContentType, type ThreadMessage } from '@janhq/core'
import { buildAgentSessionSyncMessages } from './agent-session-sync'

const textContent = (value: string) => [
  {
    type: ContentType.Text,
    text: { value, annotations: [] },
  },
]

const message = (overrides: Partial<ThreadMessage>): ThreadMessage =>
  ({
    id: 'id',
    thread_id: 'thread',
    role: 'user',
    content: [],
    status: 'ready',
    created_at: 0,
    completed_at: 0,
    object: 'thread.message',
    ...overrides,
  }) as unknown as ThreadMessage

describe('buildAgentSessionSyncMessages', () => {
  it('prefers the stored agent input text for user messages', () => {
    const result = buildAgentSessionSyncMessages([
      message({
        role: 'user',
        content: textContent('rendered text'),
        metadata: { agent_input_text: 'original input' },
      }),
      message({ role: 'assistant', content: textContent('the answer') }),
    ])

    expect(result).toEqual([
      { role: 'user', text: 'original input' },
      { role: 'assistant', text: 'the answer' },
    ])
  })

  it('joins text parts and skips non-conversation roles and empty texts', () => {
    const result = buildAgentSessionSyncMessages([
      message({
        role: 'assistant',
        content: [...textContent('part one, '), ...textContent('part two')],
      }),
      message({ role: 'system' as ThreadMessage['role'], content: textContent('sys') }),
      message({ role: 'user', content: [] }),
    ])

    expect(result).toEqual([
      { role: 'assistant', text: 'part one, part two' },
    ])
  })
})
