import type { UIMessage } from 'ai'
import {
  isEngineGoneKind,
  parseOsErrorCode,
  parseTransportKind,
} from '@/lib/transport-error'
import { withoutTurnError } from '@/lib/turn-error'
import {
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  MESSAGE_TEMPLATE_OVERHEAD_TOKENS,
  PREFLIGHT_CTX_THRESHOLD,
  estimateTokens,
} from '@/lib/prompt-size'
import { isAuthenticationError, isContextLimitError } from '@/utils/error'

/**
 * How a chat turn that failed gets back to an answer without the user
 * retyping anything.
 *
 * Two failures end most turns that never get a reply (and most of the users
 * who leave after one): the local engine went away under the request, and the
 * prompt outgrew the context window. The first is retried once on its own
 * after the engine answers again (`engine-readiness.ts`); the second can
 * leave out the oldest turns when the window cannot grow any more. Neither
 * deletes anything from the thread: the user's message and its attachments
 * stay where they are.
 */

/** Local engines whose sessions `engine-readiness` can probe and restart. */
export const RECOVERABLE_LOCAL_PROVIDERS: ReadonlySet<string> = new Set([
  'llamacpp',
  'llamacpp-upstream',
  'atomic-prism',
  'mlx',
])

/**
 * OS error codes of a refused or dropped loopback connection, for messages
 * Rust did not tag with a transport kind: Windows WSAECONNREFUSED (10061),
 * WSAECONNRESET (10054) and WSAECONNABORTED (10053); ECONNREFUSED on macOS
 * (61) and Linux (111); ECONNRESET on macOS (54) and Linux (104).
 */
const ENGINE_GONE_OS_ERRORS: ReadonlySet<number> = new Set([
  10061, 10054, 10053, 61, 111, 54, 104,
])

type ErrorRecord = {
  name?: unknown
  message?: unknown
  responseBody?: unknown
  cause?: unknown
  statusCode?: unknown
  status?: unknown
}

/** Message, raw response body and cause: where a transport tag can sit. */
function errorText(error: unknown, depth = 0): string {
  if (error == null || depth > 2) return ''
  if (typeof error === 'string') return error
  if (typeof error !== 'object') return ''
  const record = error as ErrorRecord
  return [
    typeof record.message === 'string' ? record.message : '',
    typeof record.responseBody === 'string' ? record.responseBody : '',
    errorText(record.cause, depth + 1),
  ]
    .filter(Boolean)
    .join(' ')
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as ErrorRecord
  const code = record.statusCode ?? record.status
  return typeof code === 'number' && Number.isFinite(code) ? code : undefined
}

/**
 * A stop the user asked for. Rust answers a cancelled stream with exactly
 * `Request aborted`; the localized Windows text of 10053 ("…was aborted by the
 * software in your host machine") is not one, so this does not look for the
 * word "aborted" in general.
 */
function isUserAbort(error: unknown): boolean {
  if (error && typeof error === 'object') {
    if ((error as ErrorRecord).name === 'AbortError') return true
  }
  return /^\s*Request aborted\s*$/.test(errorText(error))
}

/**
 * Whether a turn failed because the local engine is gone: nothing listened on
 * its port, or the connection was reset or cut off mid-answer. Classified on
 * the `[transport:<kind>]` tag Rust adds; an untagged message (older builds)
 * on the OS error code. Never a user stop, an auth or other 4xx answer, or a
 * context overflow — those have their own handling and a retry would not
 * help them.
 */
export function isEngineGoneError(error: unknown): boolean {
  if (!error || isUserAbort(error)) return false
  if (isContextLimitError(error)) return false
  const status = statusOf(error)
  if (status !== undefined && status >= 400 && status < 500) return false
  const text = errorText(error)
  if (!text || isAuthenticationError(text)) return false
  const kind = parseTransportKind(text)
  if (kind !== undefined) return isEngineGoneKind(kind)
  const code = parseOsErrorCode(text)
  return code !== undefined && ENGINE_GONE_OS_ERRORS.has(code)
}

type Part = UIMessage['parts'][number]

function isToolPart(part: Part): boolean {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-')
}

/** A tool part whose result was delivered (or whose failure was). */
function isResolvedToolPart(part: Part): boolean {
  if (!isToolPart(part)) return false
  const state = (part as { state?: string }).state
  return state === 'output-available' || state === 'output-error'
}

/** `toolCallId`s of the tool calls in `message` that already ran. */
export function resolvedToolCallIds(message: UIMessage | undefined): string[] {
  if (!message || message.role !== 'assistant') return []
  return message.parts
    .filter(isResolvedToolPart)
    .map((part) => (part as { toolCallId?: string }).toolCallId)
    .filter((id): id is string => typeof id === 'string')
}

/** The user message that started the turn the conversation ends with. */
export function turnUserMessageId(
  messages: readonly UIMessage[]
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages[index].id
  }
  return undefined
}

/**
 * The failed assistant message cut back to its last tool call that ran:
 * what came after it (the failed step's partial text and any call it queued
 * but never ran) goes, every call that ran keeps its result, and the stored
 * failure reason goes too. Continuing from here sends those results to the
 * model instead of running the calls again.
 */
export function resumableAssistantMessage(message: UIMessage): UIMessage {
  let lastResolved = -1
  message.parts.forEach((part, index) => {
    if (isResolvedToolPart(part)) lastResolved = index
  })
  const parts = message.parts
    .slice(0, lastResolved + 1)
    .filter((part) => !isToolPart(part) || isResolvedToolPart(part))
  return withoutTurnError({ ...message, parts })
}

export type EngineRecoveryPlan =
  | {
      /** Answer the turn again from its user message. */
      kind: 'regenerate'
      /** The user message the turn started from; one automatic retry per key. */
      turnKey: string
      /** The failed assistant message the retry replaces, when there is one. */
      failedMessageId: string | undefined
    }
  | {
      /**
       * Continue the failed assistant message after its finished tool calls:
       * their results are sent again, the calls are not run again.
       */
      kind: 'resume'
      turnKey: string
      failedMessageId: string
      /** The conversation to continue: the failed message cut back. */
      messages: UIMessage[]
      reusedToolCallIds: string[]
    }

/**
 * How to retry the turn the conversation ends with after the engine came
 * back, or `undefined` when there is no turn to retry.
 *
 * A failed turn whose earlier steps already ran tools is resumed in place,
 * keyed by `toolCallId`: a regenerate would throw those results away and run
 * the calls again when the model asks for them a second time — a command run
 * twice, a message sent twice. A turn with no finished tool call is simply
 * regenerated.
 */
export function planEngineRecovery({
  messages,
}: {
  messages: readonly UIMessage[]
}): EngineRecoveryPlan | undefined {
  const turnKey = turnUserMessageId(messages)
  if (!turnKey) return undefined
  const last = messages.at(-1)
  if (!last) return undefined
  if (last.role === 'user') {
    return { kind: 'regenerate', turnKey, failedMessageId: undefined }
  }
  const reusedToolCallIds = resolvedToolCallIds(last)
  if (reusedToolCallIds.length === 0) {
    return { kind: 'regenerate', turnKey, failedMessageId: last.id }
  }
  return {
    kind: 'resume',
    turnKey,
    failedMessageId: last.id,
    messages: [...messages.slice(0, -1), resumableAssistantMessage(last)],
    reusedToolCallIds,
  }
}

/** Tokens an attached file is counted as; its real cost is engine-specific. */
export const FILE_PART_TOKENS = 768

/** Rough token cost of one message as the model will see it (chars/token heuristic). */
export function estimateUIMessageTokens(message: UIMessage): number {
  let tokens = MESSAGE_TEMPLATE_OVERHEAD_TOKENS
  for (const part of message.parts) {
    if (part.type === 'text' || part.type === 'reasoning') {
      tokens += estimateTokens(part.text ?? '')
    } else if (part.type === 'file') {
      tokens += FILE_PART_TOKENS
    } else if (isToolPart(part)) {
      const tool = part as {
        input?: unknown
        output?: unknown
        errorText?: unknown
      }
      tokens += estimateTokens(
        JSON.stringify({
          input: tool.input ?? null,
          output: tool.output ?? tool.errorText ?? null,
        })
      )
    }
  }
  return tokens
}

/**
 * The per-message estimate, scaled up when the pre-flight measured the last
 * prompt (`/apply-template` + `/tokenize`) at more than the heuristic says:
 * a heuristic that undercounts would keep turns that do not fit.
 */
export function calibratedMessageEstimate({
  messages,
  measuredPromptTokens,
  fixedTokens,
}: {
  messages: readonly UIMessage[]
  /** Tokens of the last prompt as measured by the engine; omit when it was not. */
  measuredPromptTokens?: number
  /** System prompt and tool schemas inside that measurement. */
  fixedTokens: number
}): (message: UIMessage) => number {
  const heuristic = messages.reduce(
    (sum, message) => sum + estimateUIMessageTokens(message),
    0
  )
  const measured =
    measuredPromptTokens !== undefined
      ? measuredPromptTokens - fixedTokens
      : undefined
  const scale =
    measured !== undefined && heuristic > 0
      ? Math.max(1, measured / heuristic)
      : 1
  return (message) => Math.ceil(estimateUIMessageTokens(message) * scale)
}

/** Tokens the messages may take in a window, after the reply and the fixed parts. */
export function historyTrimBudget({
  windowTokens,
  reserveTokens = DEFAULT_OUTPUT_RESERVE_TOKENS,
  fixedTokens,
}: {
  windowTokens: number
  reserveTokens?: number
  fixedTokens: number
}): number {
  return (
    Math.floor(windowTokens * PREFLIGHT_CTX_THRESHOLD) -
    reserveTokens -
    fixedTokens
  )
}

export type HistoryTrimPlan = {
  /** First message still sent to the model; a user message. */
  keepFromId: string
  /** Messages left out, oldest first. */
  droppedMessages: number
}

/**
 * Which oldest turns to leave out of the request so the rest fits `budget`:
 * the latest user message (with its attachments) is always kept, and before
 * it as many whole recent turns as fit. Whole turns only — a tool result
 * without the call it answers is a history no provider accepts. At least one
 * turn is left out: the engine already said the whole history does not fit,
 * whatever the estimate says. `undefined` when there is nothing older than
 * the latest user message to leave out.
 *
 * `messages` is what the retry sends: the history up to and including the
 * latest user message. The system prompt is not part of it; the transport
 * adds it to every request.
 */
export function planHistoryTrim({
  messages,
  budgetTokens,
  estimate = estimateUIMessageTokens,
}: {
  messages: readonly UIMessage[]
  budgetTokens: number
  estimate?: (message: UIMessage) => number
}): HistoryTrimPlan | undefined {
  const starts: number[] = []
  messages.forEach((message, index) => {
    if (message.role === 'user') starts.push(index)
  })
  const latest = starts.at(-1)
  if (latest === undefined || latest === 0) return undefined

  const cost = (from: number, to: number) =>
    messages
      .slice(from, to)
      .reduce((sum, message) => sum + estimate(message), 0)

  let keepFrom = latest
  let used = cost(latest, messages.length)
  for (let turn = starts.length - 2; turn >= 0; turn -= 1) {
    const start = starts[turn]
    const turnCost = cost(start, keepFrom)
    if (used + turnCost > budgetTokens) break
    used += turnCost
    keepFrom = start
  }
  // Everything fits by the estimate: leave the oldest turn out anyway. A
  // conversation that starts with a user message has a second turn here,
  // since the latest one is not the first.
  if (keepFrom === 0) keepFrom = starts[1]
  return { keepFromId: messages[keepFrom].id, droppedMessages: keepFrom }
}

/**
 * The conversation from `startId` on; all of it when there is no start or the
 * start is no longer in it (deleted, or a regenerate went back past it).
 */
export function withoutHistoryBefore<T extends { id: string }>(
  messages: T[],
  startId: string | undefined
): T[] {
  if (!startId) return messages
  const index = messages.findIndex((message) => message.id === startId)
  return index > 0 ? messages.slice(index) : messages
}
