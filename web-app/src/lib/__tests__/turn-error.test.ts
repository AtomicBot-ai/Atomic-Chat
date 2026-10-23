import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { MessageStatus } from '@janhq/core'
import { convertThreadMessageToUIMessage } from '@/lib/messages'
import {
  finishedAssistantMessage,
  isEmptyFailedTurn,
  resolveTurnError,
  retryTarget,
  stepEndsTurn,
  turnErrorOf,
  withoutEmptyFailedTurns,
} from '@/lib/turn-error'
import { isAuthenticationError } from '@/utils/error'

// What the AI SDK hands `onFinish` when the request failed before any chunk
// arrived: an assistant message with no parts.
const failedBeforeAnyChunk: UIMessage = {
  id: 'assistant-failed',
  role: 'assistant',
  parts: [],
}

const userMessage: UIMessage = {
  id: 'user-1',
  role: 'user',
  parts: [{ type: 'text', text: 'hello' }],
}

// The error the chat sees for OpenAI with a bad key: the UI message stream
// carries only the text, so this is a plain Error.
const authFailure = new Error(
  'Incorrect API key provided: sk-bad. You can find your API key at https://platform.openai.com/account/api-keys.'
)

describe('finishedAssistantMessage', () => {
  it('keeps a failed turn as an Error message with the reason it failed', () => {
    const stored = finishedAssistantMessage({
      message: failedBeforeAnyChunk,
      threadId: 'thread-1',
      isAbort: false,
      isError: true,
      error: authFailure,
      now: 1,
    })

    expect(stored?.status).toBe(MessageStatus.Error)
    expect(stored?.id).toBe('assistant-failed')
    expect(stored?.thread_id).toBe('thread-1')
    expect(turnErrorOf(stored ?? undefined)).toEqual({
      message: authFailure.message,
    })
  })

  it('reloads a failed turn as the same authentication error with a retry target', () => {
    const stored = finishedAssistantMessage({
      message: failedBeforeAnyChunk,
      threadId: 'thread-1',
      isAbort: false,
      isError: true,
      error: authFailure,
    })!
    // What the thread page holds after a relaunch: the files, converted.
    const reloaded = convertThreadMessageToUIMessage(
      JSON.parse(JSON.stringify(stored))
    )!

    const shown = resolveTurnError({
      liveError: undefined,
      messages: [userMessage, reloaded],
      requestActive: false,
    })

    expect(shown.error?.message).toBe(authFailure.message)
    expect(isAuthenticationError(shown.error)).toBe(true)
    expect(shown.failedMessageId).toBe('assistant-failed')
    // The empty reply is not shown; the error card stands in for it.
    expect(isEmptyFailedTurn(reloaded)).toBe(true)
  })

  it('keeps the HTTP status of an error that carried one', () => {
    const stored = finishedAssistantMessage({
      message: failedBeforeAnyChunk,
      threadId: 'thread-1',
      isAbort: false,
      isError: true,
      error: Object.assign(new Error('Request failed'), { statusCode: 401 }),
    })!

    const shown = resolveTurnError({
      liveError: undefined,
      messages: [convertThreadMessageToUIMessage(stored)!],
      requestActive: false,
    })

    expect(isAuthenticationError(shown.error)).toBe(true)
  })

  it('keeps what a failed turn received before the error', () => {
    const stored = finishedAssistantMessage({
      message: {
        id: 'assistant-partial',
        role: 'assistant',
        parts: [{ type: 'text', text: 'The answer is' }],
      },
      threadId: 'thread-1',
      isAbort: false,
      isError: true,
      error: new Error('socket hang up'),
    })!

    expect(stored.status).toBe(MessageStatus.Error)
    expect(stored.content[0].text?.value).toBe('The answer is')
    expect(isEmptyFailedTurn(convertThreadMessageToUIMessage(stored)!)).toBe(
      false
    )
  })

  it('stores a finished reply as Ready without an error', () => {
    const stored = finishedAssistantMessage({
      message: {
        id: 'assistant-ok',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hi!' }],
      },
      threadId: 'thread-1',
      isAbort: false,
      isError: false,
    })!

    expect(stored.status).toBe(MessageStatus.Ready)
    expect(turnErrorOf(stored)).toBeUndefined()
  })

  it('drops a stopped turn that received nothing', () => {
    expect(
      finishedAssistantMessage({
        message: failedBeforeAnyChunk,
        threadId: 'thread-1',
        isAbort: true,
        isError: false,
      })
    ).toBeNull()
  })
})

describe('resolveTurnError', () => {
  const failed = convertThreadMessageToUIMessage(
    finishedAssistantMessage({
      message: failedBeforeAnyChunk,
      threadId: 'thread-1',
      isAbort: false,
      isError: true,
      error: authFailure,
    })!
  )!

  it('prefers the live error', () => {
    const live = new Error('live')
    expect(
      resolveTurnError({
        liveError: live,
        messages: [userMessage, failed],
        requestActive: false,
      }).error
    ).toBe(live)
  })

  it('shows no stored error while a retry is running', () => {
    expect(
      resolveTurnError({
        liveError: undefined,
        messages: [userMessage, failed],
        requestActive: true,
      })
    ).toEqual({ error: undefined, failedMessageId: undefined })
  })

  it('shows no stored error once the failed turn is not the last message', () => {
    expect(
      resolveTurnError({
        liveError: undefined,
        messages: [userMessage, failed, userMessage],
        requestActive: false,
      }).error
    ).toBeUndefined()
  })
})

describe('withoutEmptyFailedTurns', () => {
  it('leaves failed turns that produced nothing out of the model history', () => {
    const failed = convertThreadMessageToUIMessage(
      finishedAssistantMessage({
        message: failedBeforeAnyChunk,
        threadId: 'thread-1',
        isAbort: false,
        isError: true,
        error: authFailure,
      })!
    )!
    const next: UIMessage = {
      id: 'user-2',
      role: 'user',
      parts: [{ type: 'text', text: 'again' }],
    }

    expect(
      withoutEmptyFailedTurns([userMessage, failed, next]).map((m) => m.id)
    ).toEqual(['user-1', 'user-2'])
  })
})

describe('stepEndsTurn', () => {
  // A step that asked for a tool and failed before its result: the call is
  // still waiting, which on success would keep the turn going.
  const stepWithPendingCall: UIMessage = {
    id: 'assistant-step',
    role: 'assistant',
    parts: [
      {
        type: 'tool-web_search',
        toolCallId: 'call-1',
        state: 'input-available',
        input: { query: 'x' },
      } as UIMessage['parts'][number],
    ],
  }

  it('ends a failed turn, so the tool calls it queued are not run', () => {
    expect(
      stepEndsTurn({
        message: stepWithPendingCall,
        isAbort: false,
        isError: true,
      })
    ).toBe(true)
  })

  it('keeps a successful turn going while a tool call waits for its result', () => {
    expect(
      stepEndsTurn({
        message: stepWithPendingCall,
        isAbort: false,
        isError: false,
      })
    ).toBe(false)
  })
})

describe('retryTarget', () => {
  const storedFailed = finishedAssistantMessage({
    message: failedBeforeAnyChunk,
    threadId: 'thread-1',
    isAbort: false,
    isError: true,
    error: new Error('the request exceeds the available context size.'),
  })!
  const storedUser = { id: 'user-1', role: 'user', metadata: {} }

  it('retries in place of a failed turn the Chat shows, so it is deleted', () => {
    expect(
      retryTarget({
        requestedId: undefined,
        stored: [storedUser, storedFailed],
        shown: [{ id: 'user-1' }, { id: 'assistant-failed' }],
      })
    ).toEqual({ messageId: 'assistant-failed', discardId: undefined })
  })

  it('discards a failed turn the Chat does not show before retrying', () => {
    expect(
      retryTarget({
        requestedId: undefined,
        stored: [storedUser, storedFailed],
        shown: [{ id: 'user-1' }],
      })
    ).toEqual({ messageId: undefined, discardId: 'assistant-failed' })
  })

  it('leaves a plain retry alone when the last turn did not fail', () => {
    expect(
      retryTarget({
        requestedId: undefined,
        stored: [storedUser, { id: 'a-ok', role: 'assistant', metadata: {} }],
        shown: [{ id: 'user-1' }, { id: 'a-ok' }],
      })
    ).toEqual({ messageId: undefined, discardId: undefined })
  })

  it('keeps an explicit target', () => {
    expect(
      retryTarget({
        requestedId: 'user-1',
        stored: [storedUser, storedFailed],
        shown: [{ id: 'user-1' }, { id: 'assistant-failed' }],
      })
    ).toEqual({ messageId: 'user-1', discardId: undefined })
  })
})
