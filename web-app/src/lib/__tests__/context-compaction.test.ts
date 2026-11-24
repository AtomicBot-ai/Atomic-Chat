import type { ModelMessage } from 'ai'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  appliedCompaction,
  autoCompactionKey,
  boundaryFromKeepFrom,
  claimAutoCompaction,
  compactsHistory,
  formatCompactionTokens,
  hadAutoCompaction,
  hasCompactableHistory,
  historyToLatestUser,
  indexedOpenAiMessages,
  laterHistoryStart,
  planOverflowRecovery,
  readThreadCompaction,
  resetAutoCompactions,
  threadCompactionFrom,
  withCompactionSummary,
  type ThreadCompaction,
} from '../context-compaction'
import { decideOverflowAction, summaryBlock } from '../core-context-contract'

const conversation = [
  { id: 'u1', role: 'user' },
  { id: 'a1', role: 'assistant' },
  { id: 'u2', role: 'user' },
  { id: 'a2', role: 'assistant' },
  { id: 'u3', role: 'user' },
]

const stored: ThreadCompaction = {
  summary: 'The user asked about tides.',
  upToMessageId: 'u3',
  summarizedCount: 4,
  tokensBefore: 28_000,
  tokensAfter: 3_000,
  modelId: 'qwen',
  provider: 'vllm',
  createdAt: 1,
}

describe('readThreadCompaction', () => {
  it('reads a stored compaction', () => {
    expect(readThreadCompaction({ compaction: stored })).toEqual(stored)
  })

  it('ignores a missing or malformed one', () => {
    expect(readThreadCompaction(undefined)).toBeUndefined()
    expect(readThreadCompaction({})).toBeUndefined()
    expect(
      readThreadCompaction({ compaction: { ...stored, summary: ' ' } })
    ).toBeUndefined()
    expect(
      readThreadCompaction({ compaction: { ...stored, upToMessageId: 3 } })
    ).toBeUndefined()
  })
})

describe('appliedCompaction', () => {
  it('applies while its first kept message is a later user message', () => {
    expect(appliedCompaction(conversation, stored)).toBe(stored)
  })

  it('is left behind when its boundary is gone, first or not a user message', () => {
    expect(
      appliedCompaction(conversation, { ...stored, upToMessageId: 'gone' })
    ).toBeUndefined()
    expect(
      appliedCompaction(conversation, { ...stored, upToMessageId: 'u1' })
    ).toBeUndefined()
    expect(
      appliedCompaction(conversation, { ...stored, upToMessageId: 'a2' })
    ).toBeUndefined()
  })
})

describe('compactsHistory', () => {
  it.each([
    ['llamacpp-upstream', true],
    ['mlx', true],
    ['vllm', true],
    ['foundry-local', true],
    ['foundation-models', true],
    ['openai', false],
    [undefined, false],
  ])('%s → %s', (provider, expected) => {
    expect(compactsHistory(provider)).toBe(expected)
  })
})

describe('laterHistoryStart', () => {
  it('picks the later start that is in the conversation', () => {
    expect(laterHistoryStart(conversation, ['u2', 'u3'])).toBe('u3')
    expect(laterHistoryStart(conversation, ['u3', 'u2'])).toBe('u3')
    expect(laterHistoryStart(conversation, ['gone', 'u2'])).toBe('u2')
    expect(laterHistoryStart(conversation, [undefined, 'gone'])).toBeUndefined()
  })
})

describe('withCompactionSummary', () => {
  it('appends the summary block to the system prompt', () => {
    expect(withCompactionSummary('Be brief.', stored)).toBe(
      `Be brief.\n\n${summaryBlock(stored.summary)}`
    )
    expect(withCompactionSummary(undefined, stored)).toBe(
      summaryBlock(stored.summary)
    )
    expect(withCompactionSummary('Be brief.', undefined)).toBe('Be brief.')
  })
})

const text = (role: 'user' | 'assistant', value: string): ModelMessage =>
  ({ role, content: [{ type: 'text', text: value }] }) as ModelMessage

describe('indexedOpenAiMessages and boundaryFromKeepFrom', () => {
  // An assistant step with a tool result becomes two model messages, and a
  // tool's image is hoisted into a user message of its own.
  const groups = [
    { id: 'u1', messages: [text('user', 'first question')] },
    {
      id: 'a1',
      messages: [
        text('assistant', 'calling a tool'),
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'search',
              output: { type: 'text', value: 'result' },
            },
          ],
        } as ModelMessage,
      ],
    },
    { id: 'a1_toolimg', messages: [text('user', 'image')] },
    { id: 'u2', messages: [text('user', 'second question')] },
    { id: 'a2', messages: [text('assistant', 'answer')] },
    { id: 'u3', messages: [text('user', 'latest question')] },
  ]
  const thread = [
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant' },
    { id: 'u2', role: 'user' },
    { id: 'a2', role: 'assistant' },
    { id: 'u3', role: 'user' },
  ]
  const indexed = indexedOpenAiMessages({ system: 'Be brief.', groups })

  it('keeps the UI message each OpenAI message came from', () => {
    expect(indexed.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'user',
      'user',
      'assistant',
      'user',
    ])
    expect(indexed.sourceIds).toEqual([
      undefined,
      'u1',
      'a1',
      'a1',
      'a1_toolimg',
      'u2',
      'a2',
      'u3',
    ])
  })

  it('maps keepFrom on a user message back to it', () => {
    expect(
      boundaryFromKeepFrom({ ...indexed, keepFrom: 5, messages: thread })
    ).toBe('u2')
    expect(
      boundaryFromKeepFrom({ ...indexed, keepFrom: 7, messages: thread })
    ).toBe('u3')
  })

  it('steps back to the user message of a turn keepFrom falls inside', () => {
    // a2 → u2; the hoisted image and the tool result → a1 → u1, which is the
    // first message: nothing would be summarized.
    expect(
      boundaryFromKeepFrom({ ...indexed, keepFrom: 6, messages: thread })
    ).toBe('u2')
    expect(
      boundaryFromKeepFrom({ ...indexed, keepFrom: 4, messages: thread })
    ).toBeUndefined()
    expect(
      boundaryFromKeepFrom({ ...indexed, keepFrom: 3, messages: thread })
    ).toBeUndefined()
  })

  it('never summarizes nothing, and never the latest turn', () => {
    expect(
      boundaryFromKeepFrom({ ...indexed, keepFrom: 0, messages: thread })
    ).toBeUndefined()
    expect(
      boundaryFromKeepFrom({ ...indexed, keepFrom: 1, messages: thread })
    ).toBeUndefined()
    // Past the end: the latest user message is still sent.
    expect(
      boundaryFromKeepFrom({ ...indexed, keepFrom: 99, messages: thread })
    ).toBe('u3')
  })
})

describe('threadCompactionFrom', () => {
  it('counts the messages above the boundary', () => {
    expect(
      threadCompactionFrom({
        result: {
          summary: ' Tides. ',
          keepFrom: 5,
          summarizedCount: 3,
          tokensBefore: 9000,
          tokensAfter: 2000,
          cached: false,
        },
        boundaryId: 'u3',
        conversation,
        modelId: 'qwen',
        provider: 'vllm',
        now: 42,
      })
    ).toEqual({
      summary: 'Tides.',
      upToMessageId: 'u3',
      summarizedCount: 4,
      tokensBefore: 9000,
      tokensAfter: 2000,
      modelId: 'qwen',
      provider: 'vllm',
      createdAt: 42,
    })
  })
})

describe('hasCompactableHistory', () => {
  it('needs a user turn before the latest one, after what is already left out', () => {
    expect(hasCompactableHistory(conversation, [])).toBe(true)
    expect(hasCompactableHistory(conversation, ['u2'])).toBe(true)
    expect(hasCompactableHistory(conversation, ['u3'])).toBe(false)
    expect(hasCompactableHistory([{ id: 'u1', role: 'user' }], [])).toBe(false)
  })
})

describe('historyToLatestUser', () => {
  it('drops what follows the latest user message', () => {
    expect(
      historyToLatestUser([
        ...conversation,
        { id: 'a3', role: 'assistant' },
      ]).map((m) => m.id)
    ).toEqual(['u1', 'a1', 'u2', 'a2', 'u3'])
  })
})

describe('one automatic compaction per turn', () => {
  beforeEach(() => resetAutoCompactions())

  it('claims a turn once', () => {
    const key = autoCompactionKey('t1', conversation)
    expect(key).toBe('t1:u3')
    expect(hadAutoCompaction(key)).toBe(false)
    expect(claimAutoCompaction(key)).toBe(true)
    expect(claimAutoCompaction(key)).toBe(false)
    expect(hadAutoCompaction(key)).toBe(true)
    // The next turn has its own.
    expect(
      claimAutoCompaction(
        autoCompactionKey('t1', [...conversation, { id: 'u4', role: 'user' }])
      )
    ).toBe(true)
  })
})

describe('decideOverflowAction (contract copy)', () => {
  it('follows the core rule', () => {
    expect(
      decideOverflowAction({
        resize: 'reload',
        neededTokens: 9000,
        windowTokens: 8192,
        maxWindowTokens: 32768,
      })
    ).toBe('expand')
    expect(
      decideOverflowAction({
        resize: 'reload',
        neededTokens: 40000,
        windowTokens: 8192,
        maxWindowTokens: 32768,
      })
    ).toBe('compact')
    expect(
      decideOverflowAction({
        resize: 'restart',
        neededTokens: 9000,
        windowTokens: 8192,
        maxWindowTokens: 32768,
      })
    ).toBe('compact')
    expect(
      decideOverflowAction({
        resize: 'fixed',
        neededTokens: 9000,
        windowTokens: undefined,
      })
    ).toBe('none')
    expect(
      decideOverflowAction({
        resize: 'reload',
        neededTokens: 7000,
        windowTokens: 8192,
      })
    ).toBe('none')
  })
})

describe('planOverflowRecovery', () => {
  const base = {
    modelId: 'm',
    autoIncrease: true,
    compacted: false,
    compactionAbsent: false,
  }
  const measured = (
    providerId: string,
    resize: string,
    windowTokens?: number,
    maxWindowTokens?: number
  ) => ({ providerId, modelId: 'm', resize, windowTokens, maxWindowTokens })

  it('grows a llama.cpp window below its maximum straight to it', () => {
    expect(
      planOverflowRecovery({
        ...base,
        providerId: 'llamacpp-upstream',
        measure: measured('llamacpp-upstream', 'reload', 8192, 65536),
      })
    ).toEqual({ kind: 'expand', to: 65536 })
  })

  it('compacts a window already at its maximum, or with growth turned off', () => {
    expect(
      planOverflowRecovery({
        ...base,
        providerId: 'mlx',
        measure: measured('mlx', 'reload', 65536, 65536),
      })
    ).toEqual({ kind: 'compact' })
    expect(
      planOverflowRecovery({
        ...base,
        autoIncrease: false,
        providerId: 'mlx',
        measure: measured('mlx', 'reload', 8192, 65536),
      })
    ).toEqual({ kind: 'compact' })
  })

  it.each([
    ['vllm', 'restart'],
    ['foundry-local', 'fixed'],
    ['litert-lm', 'restart'],
  ])('compacts %s (%s)', (providerId, resize) => {
    expect(
      planOverflowRecovery({
        ...base,
        providerId,
        measure: measured(providerId, resize, 8192, 65536),
      })
    ).toEqual({ kind: 'compact' })
  })

  it('compacts once per turn', () => {
    expect(
      planOverflowRecovery({
        ...base,
        compacted: true,
        providerId: 'vllm',
        measure: measured('vllm', 'restart', 8192),
      })
    ).toEqual({ kind: 'none' })
  })

  it('grows along the ladder with an older core, and compacts nothing it lacks', () => {
    expect(
      planOverflowRecovery({
        ...base,
        compactionAbsent: true,
        providerId: 'llamacpp',
        measure: undefined,
      })
    ).toEqual({ kind: 'expand' })
    expect(
      planOverflowRecovery({
        ...base,
        compactionAbsent: true,
        providerId: 'vllm',
        measure: undefined,
      })
    ).toEqual({ kind: 'none' })
  })

  it('ignores a measure of another session', () => {
    expect(
      planOverflowRecovery({
        ...base,
        providerId: 'llamacpp',
        measure: {
          ...measured('llamacpp', 'reload', 8192, 65536),
          modelId: 'x',
        },
      })
    ).toEqual({ kind: 'expand' })
  })

  it('leaves a cloud model to the error card', () => {
    expect(
      planOverflowRecovery({
        ...base,
        providerId: 'openai',
        measure: undefined,
      })
    ).toEqual({ kind: 'none' })
  })
})

describe('formatCompactionTokens', () => {
  it('labels sizes like the context gauge', () => {
    expect(formatCompactionTokens(900)).toBe('900')
    expect(formatCompactionTokens(28_672)).toBe('28K')
  })
})
