import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { formatTransportError } from '@/lib/transport-error'
import {
  TURN_ERROR_METADATA_KEY,
  turnErrorOf,
  withoutTurnError,
} from '@/lib/turn-error'
import {
  calibratedMessageEstimate,
  estimateUIMessageTokens,
  historyTrimBudget,
  isEngineGoneError,
  planEngineRecovery,
  planHistoryTrim,
  resolvedToolCallIds,
  turnUserMessageId,
  withoutHistoryBefore,
} from '@/lib/turn-recovery'
import { OUT_OF_CONTEXT_SIZE } from '@/utils/error'

// Windows is most of the install base, and its socket errors come localized:
// these are the shapes Rust hands back, with and without the transport tag.
const WINDOWS_REFUSED =
  'Request failed: error sending request for url (http://localhost:3141/v1/chat/completions): client error (Connect): tcp connect error: No connection could be made because the target machine actively refused it. (os error 10061)'
const WINDOWS_RESET =
  'Stream error: error decoding response body: An existing connection was forcibly closed by the remote host. (os error 10054)'
const WINDOWS_ABORTED_RU =
  'Stream error: Программа на вашем хост-компьютере разорвала установленное подключение. (os error 10053)'
const WINDOWS_ABORTED_EN =
  'Stream error: An established connection was aborted by the software in your host machine. (os error 10053)'

describe('isEngineGoneError', () => {
  it.each([
    ['connect_refused', WINDOWS_REFUSED],
    ['connection_reset', WINDOWS_RESET],
    ['body_eof', 'Stream error: unexpected EOF during chunk size line'],
  ] as const)('is true for the %s transport kind', (kind, raw) => {
    expect(isEngineGoneError(new Error(formatTransportError(kind, raw)))).toBe(
      true
    )
  })

  it.each(['connect_timeout', 'idle_timeout', 'request_failed'] as const)(
    'is false for %s: the engine may still be there',
    (kind) => {
      expect(
        isEngineGoneError(new Error(formatTransportError(kind, 'whatever')))
      ).toBe(false)
    }
  )

  it.each([
    ['Windows refused', WINDOWS_REFUSED],
    ['Windows reset', WINDOWS_RESET],
    ['Windows aborted (Russian)', WINDOWS_ABORTED_RU],
    ['Windows aborted (English, says "aborted")', WINDOWS_ABORTED_EN],
    ['macOS refused', 'tcp connect error: Connection refused (os error 61)'],
    ['macOS reset', 'Connection reset by peer (os error 54)'],
    ['Linux refused', 'tcp connect error: Connection refused (os error 111)'],
    ['Linux reset', 'Connection reset by peer (os error 104)'],
  ])('reads an untagged %s message by its OS error code', (_name, raw) => {
    expect(isEngineGoneError(new Error(raw))).toBe(true)
  })

  it('finds the tag in an API error body, as the AI SDK carries a 502', () => {
    const body = JSON.stringify({
      error: {
        message: formatTransportError('connect_refused', WINDOWS_REFUSED),
      },
    })
    expect(
      isEngineGoneError(
        Object.assign(new Error('Bad Gateway'), {
          statusCode: 502,
          responseBody: body,
        })
      )
    ).toBe(true)
  })

  it('never takes a user stop, a context overflow or a 4xx for a gone engine', () => {
    expect(isEngineGoneError(new Error('Request aborted'))).toBe(false)
    expect(
      isEngineGoneError(Object.assign(new Error('x'), { name: 'AbortError' }))
    ).toBe(false)
    expect(
      isEngineGoneError(new Error(`${OUT_OF_CONTEXT_SIZE} (os error 10054)`))
    ).toBe(false)
    expect(
      isEngineGoneError(
        Object.assign(
          new Error(formatTransportError('connection_reset', 'x')),
          {
            statusCode: 401,
          }
        )
      )
    ).toBe(false)
    expect(
      isEngineGoneError(new Error('401 Unauthorized (os error 10061)'))
    ).toBe(false)
    expect(isEngineGoneError(new Error('Model not found'))).toBe(false)
    expect(isEngineGoneError(undefined)).toBe(false)
  })
})

const image = {
  type: 'file' as const,
  mediaType: 'image/png',
  url: 'data:image/png;base64,AAAA',
}

const user = (id: string, text: string, withImage = false): UIMessage => ({
  id,
  role: 'user',
  parts: [...(withImage ? [image] : []), { type: 'text', text }],
})

const assistant = (id: string, text: string): UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
})

const failedTurnMetadata = {
  [TURN_ERROR_METADATA_KEY]: {
    message: formatTransportError('connection_reset', WINDOWS_RESET),
  },
}

describe('planEngineRecovery', () => {
  it('regenerates a failed turn that ran no tools, keyed by its user message', () => {
    const messages: UIMessage[] = [
      user('u1', 'hello', true),
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Half an ans' }],
        metadata: failedTurnMetadata,
      },
    ]
    expect(planEngineRecovery({ messages })).toEqual({
      kind: 'regenerate',
      turnKey: 'u1',
      failedMessageId: 'a1',
    })
  })

  it('regenerates from the user message when no assistant message was recorded', () => {
    expect(planEngineRecovery({ messages: [user('u1', 'hello')] })).toEqual({
      kind: 'regenerate',
      turnKey: 'u1',
      failedMessageId: undefined,
    })
  })

  it('resumes after finished tool calls instead of running them again', () => {
    const failed: UIMessage = {
      id: 'a1',
      role: 'assistant',
      metadata: { ...failedTurnMetadata, modelId: 'm' },
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'Let me look.' },
        {
          type: 'tool-search',
          toolCallId: 'call-1',
          state: 'output-available',
          input: { q: 'x' },
          output: { hits: 1 },
        },
        {
          type: 'tool-run_command',
          toolCallId: 'call-2',
          state: 'output-error',
          input: { cmd: 'ls' },
          errorText: 'Tool execution denied by user',
        },
        { type: 'step-start' },
        { type: 'text', text: 'Found it, the answ' },
        {
          type: 'tool-fetch',
          toolCallId: 'call-3',
          state: 'input-available',
          input: { url: 'u' },
        },
      ] as UIMessage['parts'],
    }
    const messages = [
      user('u0', 'earlier'),
      assistant('a0', 'ok'),
      user('u1', 'go', true),
      failed,
    ]

    const plan = planEngineRecovery({ messages })

    expect(plan?.kind).toBe('resume')
    if (plan?.kind !== 'resume') return
    expect(plan.turnKey).toBe('u1')
    expect(plan.failedMessageId).toBe('a1')
    expect(plan.reusedToolCallIds).toEqual(['call-1', 'call-2'])
    // The user's message and its attachment are untouched, and nothing
    // before the failed turn is dropped.
    expect(plan.messages.slice(0, 3)).toEqual(messages.slice(0, 3))
    const resumed = plan.messages[3]
    // Same assistant message, so the continuation is one answer, not two.
    expect(resumed.id).toBe('a1')
    expect(plan.messages.filter((m) => m.role === 'assistant')).toHaveLength(2)
    // Cut back to the last call that ran: the failed step's partial text and
    // its unrun call are gone, both finished calls keep their results.
    expect(resumed.parts.map((part) => part.type)).toEqual([
      'step-start',
      'text',
      'tool-search',
      'tool-run_command',
    ])
    expect(resolvedToolCallIds(resumed)).toEqual(['call-1', 'call-2'])
    // The stored failure reason does not carry into the answer.
    expect(turnErrorOf(resumed)).toBeUndefined()
    expect(resumed.metadata).toEqual({ modelId: 'm' })
    // The input is not mutated.
    expect(failed.parts).toHaveLength(7)
    expect(turnErrorOf(failed)).toBeDefined()
  })

  it('returns nothing when there is no user turn', () => {
    expect(planEngineRecovery({ messages: [] })).toBeUndefined()
    expect(
      planEngineRecovery({ messages: [assistant('a0', 'Hi!')] })
    ).toBeUndefined()
  })
})

describe('turnUserMessageId / withoutTurnError', () => {
  it('finds the user message that started the last turn', () => {
    expect(
      turnUserMessageId([
        user('u1', 'a'),
        assistant('a1', 'b'),
        user('u2', 'c'),
        assistant('a2', 'd'),
      ])
    ).toBe('u2')
    expect(turnUserMessageId([assistant('a0', 'x')])).toBeUndefined()
  })

  it('leaves a message without a stored error as it is', () => {
    const message = assistant('a1', 'fine')
    expect(withoutTurnError(message)).toBe(message)
  })
})

describe('planHistoryTrim', () => {
  // Every message costs 100 tokens: turns of a user and an assistant are 200.
  const flat = () => 100
  const conversation = [
    user('u1', 'one'),
    assistant('a1', 'one'),
    user('u2', 'two'),
    assistant('a2', 'two'),
    user('u3', 'three'),
    assistant('a3', 'three'),
    user('u4', 'latest', true),
  ]

  it('keeps the latest user message and as many recent whole turns as fit', () => {
    // 100 (latest) + 200 (turn 3) + 200 (turn 2) = 500; turn 1 would be 700.
    expect(
      planHistoryTrim({
        messages: conversation,
        budgetTokens: 600,
        estimate: flat,
      })
    ).toEqual({ keepFromId: 'u2', droppedMessages: 2 })
    expect(
      planHistoryTrim({
        messages: conversation,
        budgetTokens: 250,
        estimate: flat,
      })
    ).toEqual({ keepFromId: 'u4', droppedMessages: 6 })
  })

  it('keeps the latest user message even when it alone is over budget', () => {
    expect(
      planHistoryTrim({
        messages: conversation,
        budgetTokens: 10,
        estimate: flat,
      })
    ).toEqual({ keepFromId: 'u4', droppedMessages: 6 })
  })

  it('leaves at least the oldest turn out when the estimate says it all fits', () => {
    expect(
      planHistoryTrim({
        messages: conversation,
        budgetTokens: 10_000,
        estimate: flat,
      })
    ).toEqual({ keepFromId: 'u2', droppedMessages: 2 })
  })

  it('has nothing to drop when the latest user message is all there is', () => {
    expect(
      planHistoryTrim({
        messages: [user('u1', 'only', true)],
        budgetTokens: 10,
      })
    ).toBeUndefined()
    expect(planHistoryTrim({ messages: [], budgetTokens: 10 })).toBeUndefined()
  })

  it('never splits a turn: a tool result stays with its call', () => {
    const withTools: UIMessage[] = [
      user('u1', 'one'),
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-search',
            toolCallId: 'c1',
            state: 'output-available',
            input: {},
            output: 'x'.repeat(4000),
          },
          { type: 'text', text: 'done' },
        ] as UIMessage['parts'],
      },
      user('u2', 'two'),
    ]
    const plan = planHistoryTrim({ messages: withTools, budgetTokens: 10_000 })
    expect(plan?.keepFromId).toBe('u2')
  })

  it('a trimmed conversation still holds the latest message with its attachment', () => {
    const plan = planHistoryTrim({
      messages: conversation,
      budgetTokens: 250,
      estimate: flat,
    })!
    const sent = withoutHistoryBefore(conversation, plan.keepFromId)
    expect(sent.at(-1)).toEqual(conversation.at(-1))
    expect(sent.at(-1)?.parts).toContainEqual(image)
    // The thread itself is not touched.
    expect(conversation).toHaveLength(7)
  })
})

describe('withoutHistoryBefore', () => {
  const messages = [user('u1', 'a'), assistant('a1', 'b'), user('u2', 'c')]

  it('drops the messages before the start', () => {
    expect(withoutHistoryBefore(messages, 'u2').map((m) => m.id)).toEqual([
      'u2',
    ])
  })

  it('keeps everything with no start, or one no longer in the conversation', () => {
    expect(withoutHistoryBefore(messages, undefined)).toBe(messages)
    expect(withoutHistoryBefore(messages, 'gone')).toBe(messages)
    expect(withoutHistoryBefore(messages, 'u1')).toBe(messages)
  })
})

describe('token estimates for the trim', () => {
  it('counts text, tool payloads and attachments', () => {
    const plain = estimateUIMessageTokens(user('u', 'hello there'))
    const withFile = estimateUIMessageTokens(user('u', 'hello there', true))
    expect(withFile - plain).toBe(768)
  })

  it('scales up to the measured prompt, never down', () => {
    const messages = [user('u1', 'x'.repeat(360))] // ~100 heuristic tokens + overhead
    const base = estimateUIMessageTokens(messages[0])
    const scaled = calibratedMessageEstimate({
      messages,
      measuredPromptTokens: 500 + base * 2,
      fixedTokens: 500,
    })
    expect(scaled(messages[0])).toBe(base * 2)
    const notMeasured = calibratedMessageEstimate({
      messages,
      fixedTokens: 500,
    })
    expect(notMeasured(messages[0])).toBe(base)
    const over = calibratedMessageEstimate({
      messages,
      measuredPromptTokens: 501,
      fixedTokens: 500,
    })
    expect(over(messages[0])).toBe(base)
  })

  it('budgets the window minus the reply and the fixed parts', () => {
    expect(
      historyTrimBudget({
        windowTokens: 8192,
        reserveTokens: 1024,
        fixedTokens: 500,
      })
    ).toBe(Math.floor(8192 * 0.9) - 1024 - 500)
  })
})
