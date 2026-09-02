import { describe, expect, it } from 'vitest'
import { jsonSchema, type Tool } from 'ai'
import {
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  MESSAGE_TEMPLATE_OVERHEAD_TOKENS,
  PREFLIGHT_CTX_THRESHOLD,
  TOOL_TEMPLATE_OVERHEAD_TOKENS,
  estimatePromptTokensHeuristic,
  estimateToolTokens,
  estimateTokens,
  toOpenAiMessages,
  toOpenAiTools,
} from '../prompt-size'

describe('estimateTokens', () => {
  it('matches the Rust token_budget estimator on its reference inputs', () => {
    // max(ceil(7/3.6)=2, ceil(2*1.4)=3) — words win on short prose.
    expect(estimateTokens('one two')).toBe(3)
    // 36 chars, one word: chars win → ceil(36/3.6) = 10.
    expect(estimateTokens('x'.repeat(36))).toBe(10)
    expect(estimateTokens('')).toBe(0)
  })
})

describe('tool and prompt estimates', () => {
  const search: Tool = {
    description: 'Search the web for recent results about a topic.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look for' } },
      required: ['query'],
    }),
  }

  it('unwraps jsonSchema() and adds the per-tool template overhead', () => {
    const rendered = JSON.stringify({
      name: 'search',
      description: search.description,
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to look for' } },
        required: ['query'],
      },
    })
    expect(estimateToolTokens('search', search)).toBe(
      estimateTokens(rendered) + TOOL_TEMPLATE_OVERHEAD_TOKENS
    )
  })

  it('sums system, messages (with overhead) and tools', () => {
    const total = estimatePromptTokensHeuristic({
      system: 'You are helpful.',
      messages: [
        { role: 'user', content: 'yo' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
      ],
      tools: { search },
    })
    expect(total).toBe(
      estimateTokens('You are helpful.') +
        estimateTokens('yo') +
        estimateTokens('Hi there') +
        2 * MESSAGE_TEMPLATE_OVERHEAD_TOKENS +
        estimateToolTokens('search', search)
    )
  })

  it('renders the OpenAI wire shape llama-server /apply-template expects', () => {
    expect(toOpenAiTools({ search })).toEqual([
      {
        type: 'function',
        function: {
          name: 'search',
          description: search.description,
          parameters: expect.objectContaining({ type: 'object' }),
        },
      },
    ])
    expect(
      toOpenAiMessages({
        system: 'sys',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'a' }] },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: '1',
                toolName: 'search',
                output: { type: 'text', value: 'r' },
              },
            ],
          },
        ],
      })
    ).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a' },
      { role: 'tool', content: JSON.stringify({ type: 'text', value: 'r' }) },
    ])
  })

  it('keeps the pre-flight constants in the expected range', () => {
    expect(PREFLIGHT_CTX_THRESHOLD).toBeGreaterThan(0.5)
    expect(PREFLIGHT_CTX_THRESHOLD).toBeLessThanOrEqual(1)
    expect(DEFAULT_OUTPUT_RESERVE_TOKENS).toBeGreaterThan(0)
  })
})
