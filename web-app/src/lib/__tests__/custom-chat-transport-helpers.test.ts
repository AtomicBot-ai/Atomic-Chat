import type { UIMessage } from '@ai-sdk/react'
import { describe, expect, it } from 'vitest'

import {
  buildToolsRecord,
  splitAnthropicSerialToolUse,
  withGrammarSafeToolSchemas,
} from '../custom-chat-transport-helpers'
import { toolJsonSchema } from '@/lib/prompt-size'
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

describe('withGrammarSafeToolSchemas', () => {
  const record = (inputSchema: Record<string, unknown>) =>
    buildToolsRecord(
      [],
      [{ name: 'scrape', description: '', inputSchema, server: 'firecrawl' }],
      []
    )

  it('drops the size bounds llama.cpp turns into huge grammar repetitions', () => {
    const safe = withGrammarSafeToolSchemas(
      record({
        type: 'object',
        properties: {
          prompt: { type: 'string', maxLength: 10000, minLength: 1 },
          urls: {
            type: 'array',
            maxItems: 50,
            minItems: 1,
            items: { type: 'string', maxLength: 2000 },
          },
        },
        required: ['prompt'],
      })
    )

    expect(toolJsonSchema(safe!.scrape)).toEqual({
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        urls: { type: 'array', items: { type: 'string' } },
      },
      required: ['prompt'],
    })
  })

  it('keeps a property that is itself named after a bound', () => {
    const safe = withGrammarSafeToolSchemas(
      record({
        type: 'object',
        properties: {
          maxItems: { type: 'number' },
          maxLength: { type: 'string', maxLength: 64 },
        },
      })
    )

    expect(toolJsonSchema(safe!.scrape)).toEqual({
      type: 'object',
      properties: {
        maxItems: { type: 'number' },
        maxLength: { type: 'string' },
      },
    })
  })

  it('descends into $defs, anyOf and nested objects', () => {
    const safe = withGrammarSafeToolSchemas(
      record({
        type: 'object',
        $defs: { tag: { type: 'string', maxLength: 300 } },
        properties: {
          opts: {
            type: 'object',
            properties: {
              formats: {
                type: 'array',
                maxItems: 20,
                items: { $ref: '#/$defs/tag' },
              },
            },
          },
          who: { anyOf: [{ type: 'string', maxLength: 99 }, { type: 'null' }] },
        },
      })
    )

    expect(toolJsonSchema(safe!.scrape)).toEqual({
      type: 'object',
      $defs: { tag: { type: 'string' } },
      properties: {
        opts: {
          type: 'object',
          properties: {
            formats: { type: 'array', items: { $ref: '#/$defs/tag' } },
          },
        },
        who: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    })
  })

  it('drops a pattern that smuggles in a huge length bound', () => {
    const safe = withGrammarSafeToolSchemas(
      record({
        type: 'object',
        properties: {
          body: { type: 'string', pattern: '^.{0,5000}$' },
          host: {
            type: 'string',
            pattern: '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$',
          },
          id: { type: 'string', pattern: '^[0-9a-f]{32}$' },
        },
      })
    )

    expect(toolJsonSchema(safe!.scrape)).toEqual({
      type: 'object',
      properties: {
        body: { type: 'string' },
        host: {
          type: 'string',
          pattern: '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$',
        },
        id: { type: 'string', pattern: '^[0-9a-f]{32}$' },
      },
    })
  })

  it('leaves the record alone when there is nothing to strip', () => {
    const safe = withGrammarSafeToolSchemas(
      record({ type: 'object', properties: { q: { type: 'string' } } })
    )

    expect(toolJsonSchema(safe!.scrape)).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
    })
  })

  it('passes undefined through', () => {
    expect(withGrammarSafeToolSchemas(undefined)).toBeUndefined()
  })
})
