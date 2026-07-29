import type { UIMessage } from '@ai-sdk/react'
import { describe, expect, it } from 'vitest'

import {
  buildToolsRecord,
  splitAnthropicSerialToolUse,
} from '../custom-chat-transport-helpers'
import type { MCPTool } from '@/types/completion'

const toolPart = (name: string) =>
  ({
    type: `tool-${name}`,
    toolCallId: `${name}-id`,
    state: 'output-available',
    input: {},
    output: { ok: true },
  }) as UIMessage['parts'][number]

const message = (
  id: string,
  role: UIMessage['role'],
  parts: UIMessage['parts']
): UIMessage => ({ id, role, parts })

const tool = (
  name: string,
  server: string,
  description = `${server} ${name}`
): MCPTool => ({
  name,
  server,
  description,
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
  },
})

describe('splitAnthropicSerialToolUse', () => {
  it('splits interleaved serial tool-use into ordered waves', () => {
    const user = message('user', 'user', [{ type: 'text', text: 'start' }])
    const assistant = message('assistant', 'assistant', [
      { type: 'text', text: 'first' },
      toolPart('read'),
      toolPart('search'),
      { type: 'reasoning', text: 'next' },
      toolPart('write'),
      { type: 'text', text: 'done' },
    ])

    const result = splitAnthropicSerialToolUse([user, assistant])

    expect(result[0]).toBe(user)
    expect(result.slice(1).map(({ id }) => id)).toEqual([
      'assistant_w0',
      'assistant_w1',
      'assistant_w2',
    ])
    expect(
      result.slice(1).map(({ parts }) => parts.map((part) => part.type))
    ).toEqual([
      ['text', 'tool-read', 'tool-search'],
      ['reasoning', 'tool-write'],
      ['text'],
    ])
    expect(assistant.id).toBe('assistant')
    expect(assistant.parts).toHaveLength(6)
  })

  it('preserves the original message when there is only one tool wave', () => {
    const assistant = message('assistant', 'assistant', [
      { type: 'text', text: 'first' },
      toolPart('read'),
      toolPart('search'),
    ])

    expect(splitAnthropicSerialToolUse([assistant])).toEqual([assistant])
    expect(splitAnthropicSerialToolUse([assistant])[0]).toBe(assistant)
  })

  it('preserves empty and non-assistant messages by reference', () => {
    const empty = message('empty', 'assistant', [])
    const user = message('user', 'user', [
      { type: 'text', text: 'tool-read is ordinary text' },
    ])

    const result = splitAnthropicSerialToolUse([empty, user])

    expect(result[0]).toBe(empty)
    expect(result[1]).toBe(user)
  })
})

describe('buildToolsRecord', () => {
  it('filters disabled server/tool pairs and sorts tool names', () => {
    const result = buildToolsRecord(
      [tool('zeta', 'rag'), tool('disabled', 'rag')],
      [tool('alpha', 'mcp')],
      ['rag::disabled']
    )

    expect(Object.keys(result)).toEqual(['alpha', 'zeta'])
    expect(result.alpha.description).toBe('mcp alpha')
    expect(result.zeta.inputSchema).toBeDefined()
  })

  it('lets MCP tools replace same-named RAG tools', () => {
    const result = buildToolsRecord(
      [tool('lookup', 'rag', 'RAG version')],
      [tool('lookup', 'mcp', 'MCP version')],
      []
    )

    expect(result.lookup.description).toBe('MCP version')
  })

  it('does not let a disabled MCP duplicate erase an enabled RAG tool', () => {
    const result = buildToolsRecord(
      [tool('lookup', 'rag', 'RAG version')],
      [tool('lookup', 'mcp', 'MCP version')],
      ['mcp::lookup']
    )

    expect(result.lookup.description).toBe('RAG version')
  })
})
