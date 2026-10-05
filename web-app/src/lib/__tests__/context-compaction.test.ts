import { describe, expect, it } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'

import {
  COMPACTION_MIN_HEAD_MESSAGES,
  COMPACTION_MIN_TAIL_MESSAGES,
  buildCompactionPrompt,
  buildCompactionSummaryMessage,
  estimateUIMessageTokens,
  hasToolResultParts,
  readAutoCompaction,
  selectCompactionBoundary,
  uiMessageText,
} from '../context-compaction'

function textMessage(
  id: string,
  role: 'user' | 'assistant',
  text: string
): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] }
}

function toolCallMessage(id: string, toolCallId: string): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      {
        type: 'tool-call' as UIMessage['parts'][number]['type'],
        toolCallId,
        toolName: 'read_file',
        input: { path: '/tmp/a.txt' },
      } as never,
    ],
  }
}

function toolResultMessage(id: string, toolCallId: string): UIMessage {
  return {
    id,
    role: 'user',
    parts: [
      {
        type: 'tool-result' as UIMessage['parts'][number]['type'],
        toolCallId,
        toolName: 'read_file',
        output: 'file contents',
      } as never,
    ],
  }
}

describe('uiMessageText / estimateUIMessageTokens', () => {
  it('concatenates text parts and serializes tool parts', () => {
    const message = textMessage('a', 'user', 'hello')
    expect(uiMessageText(message)).toBe('hello')
    const withTool = toolResultMessage('b', 't1')
    expect(uiMessageText(withTool)).toContain('file contents')
    expect(estimateUIMessageTokens(message)).toBeGreaterThan(0)
  })
})

describe('hasToolResultParts', () => {
  it('detects tool results but not plain text or bare calls', () => {
    expect(hasToolResultParts(toolResultMessage('r', 't1'))).toBe(true)
    expect(hasToolResultParts(toolCallMessage('c', 't1'))).toBe(false)
    expect(hasToolResultParts(textMessage('t', 'user', 'hi'))).toBe(false)
  })
})

describe('selectCompactionBoundary', () => {
  const big = 'x'.repeat(400) // ~112 estimated tokens each

  it('keeps the newest messages within the tail budget', () => {
    const messages = [
      textMessage('m0', 'user', big),
      textMessage('m1', 'assistant', big),
      textMessage('m2', 'user', big),
      textMessage('m3', 'assistant', big),
      textMessage('m4', 'user', 'recent'),
    ]
    const boundary = selectCompactionBoundary(messages, {
      tailBudgetTokens: estimateUIMessageTokens(messages[4]),
      minTailMessages: 1,
    })
    expect(boundary).toBe(4)
    expect(messages[boundary].id).toBe('m4')
  })

  it('never separates a tool result from its call', () => {
    const messages = [
      textMessage('m0', 'user', big),
      textMessage('m1', 'assistant', big),
      toolCallMessage('m2', 't1'),
      toolResultMessage('m3', 't1'),
      textMessage('m4', 'assistant', big),
      textMessage('m5', 'user', 'recent'),
    ]
    const boundary = selectCompactionBoundary(messages, {
      // Budget only fits the last message: the naive boundary is m5, but m3's
      // result call sits in m2 — walk back until the pair is whole.
      tailBudgetTokens: 10,
      minTailMessages: 1,
    })
    expect(boundary).toBeGreaterThanOrEqual(2)
    expect(hasToolResultParts(messages[boundary])).toBe(false)
  })

  it('returns -1 when there is nothing worth compacting', () => {
    const short = [
      textMessage('m0', 'user', 'hi'),
      textMessage('m1', 'assistant', 'hello'),
    ]
    expect(
      selectCompactionBoundary(short, { tailBudgetTokens: 1000 })
    ).toBe(-1)
    // A head below the minimum is not worth a summarizer call: only one
    // older message exists here even with a tiny tail budget.
    expect(
      selectCompactionBoundary(
        [
          textMessage('m0', 'user', 'hi'),
          textMessage('m1', 'assistant', 'hello'),
          textMessage('m2', 'user', 'recent'),
        ],
        { tailBudgetTokens: 10, minTailMessages: 1 }
      )
    ).toBe(-1)
  })

  it('respects the minimum tail size', () => {
    const messages = [
      textMessage('m0', 'user', big),
      textMessage('m1', 'assistant', big),
      textMessage('m2', 'user', 'recent 1'),
      textMessage('m3', 'assistant', 'recent 2'),
    ]
    const boundary = selectCompactionBoundary(messages, {
      tailBudgetTokens: 0,
      minTailMessages: 2,
    })
    expect(boundary).toBe(messages.length - COMPACTION_MIN_TAIL_MESSAGES)
  })
})

describe('readAutoCompaction', () => {
  it('defaults to on and honours an explicit off', () => {
    expect(readAutoCompaction(undefined)).toBe(true)
    expect(readAutoCompaction({})).toBe(true)
    expect(
      readAutoCompaction({
        settings: {
          auto_compaction: { controller_props: { value: false } },
        },
      })
    ).toBe(false)
  })
})

describe('buildCompactionPrompt / buildCompactionSummaryMessage', () => {
  it('includes the transcript, roles and the system prompt', () => {
    const head = [
      textMessage('m0', 'user', 'fix the flaky test'),
      textMessage('m1', 'assistant', 'fixed it'),
    ]
    const prompt = buildCompactionPrompt({ system: 'be terse', head })
    expect(prompt).toContain('User: fix the flaky test')
    expect(prompt).toContain('Assistant: fixed it')
    expect(prompt).toContain('be terse')
    expect(prompt).toContain('<conversation_to_summarize>')
  })

  it('wraps the summary with the continuation prefix and metadata', () => {
    const message = buildCompactionSummaryMessage('1. Primary request: fix')
    expect(message.role).toBe('user')
    expect(message.metadata).toEqual({ compaction: true })
    expect(uiMessageText(message)).toContain(
      'This session is being continued from a previous conversation'
    )
    expect(uiMessageText(message)).toContain('1. Primary request: fix')
  })

  it('documents the invariants the boundary relies on', () => {
    expect(COMPACTION_MIN_HEAD_MESSAGES).toBeGreaterThan(0)
    expect(COMPACTION_MIN_TAIL_MESSAGES).toBeGreaterThan(0)
  })
})
