import { ContentType, MessageStatus, type ThreadMessage } from '@janhq/core'
import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import {
  convertThreadMessageToUIMessage,
  extractContentPartsFromUIMessage,
} from './messages'

function completedMessage(content: ThreadMessage['content']): ThreadMessage {
  return {
    id: 'assistant-1',
    object: 'thread.message',
    thread_id: 'thread-1',
    role: 'assistant',
    status: MessageStatus.Ready,
    created_at: 1,
    completed_at: 2,
    content,
  }
}

describe('tool error transcript persistence', () => {
  it('round-trips an output error instead of reloading it as a running call', () => {
    const message = {
      id: 'assistant-live',
      role: 'assistant',
      parts: [
        {
          type: 'tool-web_search_exa',
          toolCallId: 'call-1',
          state: 'output-error',
          input: { query: 'pelican' },
          errorText: 'Search provider unavailable',
        },
      ],
    } as UIMessage

    const content = extractContentPartsFromUIMessage(message)
    const restored = convertThreadMessageToUIMessage(completedMessage(content))

    expect(restored.parts).toEqual([
      expect.objectContaining({
        type: 'tool-web_search_exa',
        state: 'output-error',
        errorText: 'Search provider unavailable',
      }),
    ])
  })

  it('stores repeated identical web failures as one aggregate', () => {
    const parts = Array.from({ length: 5 }, (_, index) => ({
      type: 'tool-web_search_exa',
      toolCallId: `call-${index}`,
      state: 'output-error',
      input: { query: `variant ${index}` },
      errorText: 'Search provider unavailable',
    }))

    const content = extractContentPartsFromUIMessage({
      id: 'assistant-live',
      role: 'assistant',
      parts,
    } as UIMessage)
    const restored = convertThreadMessageToUIMessage(completedMessage(content))

    expect(content).toHaveLength(1)
    expect(restored.parts).toEqual([
      expect.objectContaining({
        state: 'output-error',
        errorText:
          'Search provider unavailable\n\n5 equivalent failures were grouped.',
      }),
    ])
  })

  it('aggregates legacy completed web calls whose errors were not recorded', () => {
    const content = Array.from({ length: 4 }, (_, index) => ({
      type: ContentType.ToolCall,
      tool_call_id: `legacy-${index}`,
      tool_name: 'web_search_exa',
      input: { query: `variant ${index}` },
    }))

    const restored = convertThreadMessageToUIMessage(
      completedMessage(content as ThreadMessage['content'])
    )

    expect(restored.parts).toEqual([
      expect.objectContaining({
        state: 'output-error',
        errorText: 'Tool result was not recorded.\n\n4 equivalent failures were grouped.',
      }),
    ])
  })

  it('does not aggregate successful searches or failures from other tools', () => {
    const message = {
      id: 'assistant-live',
      role: 'assistant',
      parts: [
        {
          type: 'tool-web_search_exa',
          toolCallId: 'search-ok',
          state: 'output-available',
          input: { query: 'pelican' },
          output: [{ type: 'text', text: 'result' }],
        },
        ...Array.from({ length: 2 }, (_, index) => ({
          type: 'tool-mcp.other',
          toolCallId: `other-${index}`,
          state: 'output-error',
          input: { id: index },
          errorText: 'Same text',
        })),
      ],
    } as UIMessage

    expect(extractContentPartsFromUIMessage(message)).toHaveLength(3)
  })
})
