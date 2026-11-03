import type { UIMessage } from 'ai'
import {
  ChatCompletionRole,
  ContentType,
  MessageStatus,
  type ThreadMessage,
} from '@janhq/core'
import { extractContentPartsFromUIMessage } from '@/lib/messages'
import { hasUnresolvedToolCallParts } from '@/lib/execute-chat-tool-calls'

/**
 * Why a chat turn failed, stored on the turn's assistant message.
 *
 * The AI SDK keeps a failed turn's error only on the in-memory Chat, so it
 * outlived a trip to Settings but not a relaunch: the thread then reloaded the
 * failed turn as an empty reply with action icons and no reason (AC-07).
 * Keeping the reason on the message lets the thread page show the same error
 * card, with the same recovery action, after a relaunch.
 */
export type PersistedTurnError = {
  message: string
  /** HTTP status when the error carried one; part of how errors are classified. */
  statusCode?: number
}

export const TURN_ERROR_METADATA_KEY = 'turn_error'

type MessageLike = { role?: string; metadata?: unknown; parts?: unknown }

function readStatusCode(error: object): number | undefined {
  const record = error as { statusCode?: unknown; status?: unknown }
  const code = record.statusCode ?? record.status
  return typeof code === 'number' && Number.isFinite(code) ? code : undefined
}

/** What to store about an error a turn failed with. */
export function describeTurnError(error: unknown): PersistedTurnError {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error && typeof error === 'object' && 'message' in error
          ? String((error as { message?: unknown }).message ?? '')
          : ''
  const statusCode =
    error && typeof error === 'object' ? readStatusCode(error) : undefined
  return {
    message: message || 'Unknown error',
    ...(statusCode !== undefined ? { statusCode } : {}),
  }
}

/** The stored reason an assistant message's turn failed, if it did. */
export function turnErrorOf(
  message: MessageLike | undefined
): PersistedTurnError | undefined {
  if (!message || message.role !== 'assistant') return undefined
  const metadata = message.metadata as Record<string, unknown> | undefined
  const stored = metadata?.[TURN_ERROR_METADATA_KEY] as
    | { message?: unknown; statusCode?: unknown }
    | undefined
  if (!stored || typeof stored.message !== 'string') return undefined
  return {
    message: stored.message,
    ...(typeof stored.statusCode === 'number'
      ? { statusCode: stored.statusCode }
      : {}),
  }
}

/** Rebuilds an `Error` the thread page's error matchers classify as before. */
export function turnErrorToError(stored: PersistedTurnError): Error {
  const error = new Error(stored.message)
  if (stored.statusCode !== undefined) {
    Object.assign(error, { statusCode: stored.statusCode })
  }
  return error
}

/** Text, reasoning, files or tool calls: anything a reader would see. */
function hasVisibleParts(message: MessageLike): boolean {
  const parts = Array.isArray(message.parts)
    ? (message.parts as Array<{ type?: string; text?: string }>)
    : []
  return parts.some((part) => {
    if (part.type === 'text' || part.type === 'reasoning') {
      return (part.text ?? '').trim() !== ''
    }
    return (
      part.type === 'file' ||
      part.type === 'dynamic-tool' ||
      (part.type?.startsWith('tool-') ?? false)
    )
  })
}

/**
 * A failed turn that produced nothing. The error card stands in for it on the
 * page, and it is no reply the model should be shown as history either.
 */
export function isEmptyFailedTurn(message: MessageLike): boolean {
  return turnErrorOf(message) !== undefined && !hasVisibleParts(message)
}

/** The conversation without failed turns that produced nothing. */
export function withoutEmptyFailedTurns<T extends UIMessage>(
  messages: T[]
): T[] {
  return messages.some(isEmptyFailedTurn)
    ? messages.filter((message) => !isEmptyFailedTurn(message))
    : messages
}

/**
 * The assistant message to store when a chat turn ends, or null when there is
 * nothing to keep.
 *
 * A stopped (`isAbort`) or failed (`isError`) turn keeps only what actually
 * arrived — a tool call cut off before its result would leave the history with
 * a call no provider accepts unanswered. A stopped turn that received nothing
 * is dropped; a failed one is kept anyway, as `Error`, with the reason it
 * failed, so the reason survives a relaunch.
 */
export function finishedAssistantMessage({
  message,
  threadId,
  isAbort,
  isError,
  error,
  now = Date.now(),
}: {
  message: UIMessage
  threadId: string
  isAbort: boolean
  isError: boolean
  /** The error the turn failed with; read only when `isError`. */
  error?: unknown
  now?: number
}): ThreadMessage | null {
  const allParts = extractContentPartsFromUIMessage(message)
  const contentParts =
    isAbort || isError
      ? allParts.filter((part) =>
          part.type === ContentType.ToolCall
            ? (part as { output?: unknown }).output !== undefined
            : part.type === ContentType.Image ||
              (part.text?.value ?? '').trim() !== ''
        )
      : allParts
  if (contentParts.length === 0 && !isError) return null

  const metadata = {
    ...((message.metadata ?? {}) as Record<string, unknown>),
    ...(isError ? { [TURN_ERROR_METADATA_KEY]: describeTurnError(error) } : {}),
  }
  return {
    type: 'text',
    role: ChatCompletionRole.Assistant,
    // `extractContentPartsFromUIMessage` stands in an empty text part for no
    // content, which is what the rest of the app expects to find.
    content:
      contentParts.length > 0
        ? contentParts
        : extractContentPartsFromUIMessage({ ...message, parts: [] }),
    id: message.id,
    object: 'thread.message',
    thread_id: threadId,
    status: isAbort
      ? MessageStatus.Stopped
      : isError
        ? MessageStatus.Error
        : MessageStatus.Ready,
    created_at: now,
    completed_at: now,
    metadata,
  }
}

/**
 * The error the thread page shows under the conversation: the live one first,
 * then a failed turn stored as the last message — which is what is left of a
 * live error after a relaunch. `failedMessageId` names that stored turn, so a
 * retry replaces it instead of leaving it behind in the thread file.
 */
export function resolveTurnError({
  liveError,
  messages,
  requestActive,
}: {
  liveError: Error | null | undefined
  messages: readonly UIMessage[]
  requestActive: boolean
}): { error: Error | undefined; failedMessageId: string | undefined } {
  const last = messages.at(-1)
  const stored = requestActive ? undefined : turnErrorOf(last)
  const failedMessageId = stored ? last?.id : undefined
  if (liveError) return { error: liveError, failedMessageId }
  return {
    error: stored ? turnErrorToError(stored) : undefined,
    failedMessageId,
  }
}

/**
 * Whether a finished step ends the turn: the composer is released and the
 * tool calls the step queued are dropped instead of run. A failed step always
 * ends it — the AI SDK sends no follow-up after an error and the stored turn
 * keeps no call still waiting for its result, so a tool run then would act
 * unseen (maybe behind an approval prompt) with its output going nowhere.
 * Otherwise the turn ends when nothing in the message waits on a tool result.
 */
export function stepEndsTurn({
  message,
  isAbort,
  isError,
}: {
  message: UIMessage
  isAbort: boolean
  isError: boolean
}): boolean {
  if (isAbort) return false
  return isError || !hasUnresolvedToolCallParts(message)
}

/**
 * What a retry regenerates from. A retry with no target — the error card, or
 * the context increase after an overflow — has to replace a failed turn left
 * as the last stored message: the AI SDK only drops it from the Chat, so
 * without a delete every retry would leave one more hidden failed turn in the
 * thread file. `messageId` is the regenerate target (the failed turn when the
 * Chat holds it too); `discardId` is a failed turn to delete that the Chat
 * does not hold.
 */
export function retryTarget({
  requestedId,
  stored,
  shown,
}: {
  requestedId: string | undefined
  stored: readonly MessageLike[]
  shown: readonly { id: string }[]
}): { messageId: string | undefined; discardId: string | undefined } {
  if (requestedId) return { messageId: requestedId, discardId: undefined }
  const last = stored.at(-1) as (MessageLike & { id?: string }) | undefined
  const failedId = turnErrorOf(last) ? last?.id : undefined
  if (!failedId) return { messageId: undefined, discardId: undefined }
  return shown.some((message) => message.id === failedId)
    ? { messageId: failedId, discardId: undefined }
    : { messageId: undefined, discardId: failedId }
}
