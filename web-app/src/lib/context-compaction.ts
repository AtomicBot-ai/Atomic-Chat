import type { ModelMessage } from 'ai'

import { composeSystemMessage } from '@/lib/chat-skill-injection'
import { contextSupport } from '@/lib/context-support'
import {
  summaryBlock,
  type CompactResult,
  type ContextChatMessage,
} from '@/lib/core-context-contract'
import { formatContextLength } from '@/lib/model-card'
import { toOpenAiMessages } from '@/lib/prompt-size'

/**
 * History compaction of a chat thread: the oldest turns of a local chat that
 * no longer fits its model's window are summarized by the same model, and the
 * chat goes on with the summary in place of them.
 *
 * The thread keeps every message; only the request leaves the summarized ones
 * out. What a compaction did is stored on the thread (`metadata.compaction`),
 * so it holds across a relaunch and a switch of threads: the first message
 * still sent (`upToMessageId`, always a user message) and the summary, which
 * rides the system prompt of every later request. A newer compaction replaces
 * the older one; its summary covers the older summary too, because that
 * summary was part of the system prompt it was asked to summarize.
 */

/** Key of the compaction in a thread's `metadata`. */
export const COMPACTION_METADATA_KEY = 'compaction'

export type ThreadCompaction = {
  /** The summary of every message before `upToMessageId`. */
  summary: string
  /** The first message still sent to the model; a user message. */
  upToMessageId: string
  /** How many messages of the thread are above it, summarized. */
  summarizedCount: number
  /** The prompt before and after, as the core counted it. */
  tokensBefore: number
  tokensAfter: number
  modelId: string
  provider: string
  /** When it was made, ms since the epoch. */
  createdAt: number
}

type MessageLike = { id: string; role: string }

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0

/** The compaction stored on a thread, or `undefined` when it has none (or a malformed one). */
export function readThreadCompaction(
  metadata: Record<string, unknown> | undefined
): ThreadCompaction | undefined {
  const raw = metadata?.[COMPACTION_METADATA_KEY]
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.summary !== 'string' || !record.summary.trim())
    return undefined
  if (typeof record.upToMessageId !== 'string' || !record.upToMessageId) {
    return undefined
  }
  return {
    summary: record.summary,
    upToMessageId: record.upToMessageId,
    summarizedCount: count(record.summarizedCount),
    tokensBefore: count(record.tokensBefore),
    tokensAfter: count(record.tokensAfter),
    modelId: typeof record.modelId === 'string' ? record.modelId : '',
    provider: typeof record.provider === 'string' ? record.provider : '',
    createdAt: count(record.createdAt),
  }
}

/**
 * `compaction` when it applies to `messages`: its first kept message is still
 * in the conversation, is a user message and has history before it. A
 * regenerate or an edit that went back past it, or a deleted message, leaves
 * the compaction behind; the whole history is sent again then.
 */
export function appliedCompaction(
  messages: readonly MessageLike[],
  compaction: ThreadCompaction | undefined
): ThreadCompaction | undefined {
  if (!compaction) return undefined
  const index = messages.findIndex((m) => m.id === compaction.upToMessageId)
  if (index <= 0 || messages[index].role !== 'user') return undefined
  return compaction
}

/**
 * Whether a thread's stored compaction is used for `providerId`: every local
 * engine compacts; a cloud model has a window of its own and gets the whole
 * history.
 */
export function compactsHistory(providerId: string | undefined): boolean {
  return contextSupport(providerId).resize !== undefined
}

/**
 * The latest of the history starts that are in `messages`: a compaction's
 * first kept message and the in-memory start of "Shorten history". `undefined`
 * when none is.
 */
export function laterHistoryStart(
  messages: readonly { id: string }[],
  starts: ReadonlyArray<string | undefined>
): string | undefined {
  let best: { id: string; index: number } | undefined
  for (const id of starts) {
    if (!id) continue
    const index = messages.findIndex((m) => m.id === id)
    if (index < 0) continue
    if (!best || index > best.index) best = { id, index }
  }
  return best?.id
}

/** The system prompt with the compaction's summary appended, as every request carries it. */
export function withCompactionSummary(
  system: string | undefined,
  compaction: Pick<ThreadCompaction, 'summary'> | undefined
): string | undefined {
  return composeSystemMessage(
    system,
    compaction ? summaryBlock(compaction.summary) : undefined
  )
}

/** OpenAI messages of a request and, for each, the UI message it came from (`undefined`: the system prompt). */
export type IndexedChatMessages = {
  messages: ContextChatMessage[]
  sourceIds: Array<string | undefined>
}

/**
 * The OpenAI messages of a request, the system prompt first, with the id of
 * the UI message each one was converted from. One UI message can become
 * several (an assistant step and its tool results), and a tool's image is
 * hoisted into a message of its own: the index map is what turns the core's
 * `keepFrom` back into a message of the thread.
 */
export function indexedOpenAiMessages(args: {
  system: string | undefined
  groups: ReadonlyArray<{ id: string; messages: readonly ModelMessage[] }>
}): IndexedChatMessages {
  const messages: ContextChatMessage[] = []
  const sourceIds: Array<string | undefined> = []
  if (args.system) {
    messages.push({ role: 'system', content: args.system })
    sourceIds.push(undefined)
  }
  for (const group of args.groups) {
    for (const message of toOpenAiMessages({ messages: group.messages })) {
      messages.push(message)
      sourceIds.push(group.id)
    }
  }
  return { messages, sourceIds }
}

/**
 * The first UI message the request still sends after a compaction answered
 * with `keepFrom`: the user message the kept part starts with, or the user
 * message before it when `keepFrom` falls inside a turn (the summary then also
 * covers the start of a turn that is sent whole — nothing is lost). A
 * boundary must leave history before it: `undefined` when `keepFrom` keeps
 * everything from the first message of `messages`.
 *
 * `messages` are the UI messages the request was built from, in order.
 */
export function boundaryFromKeepFrom(args: {
  sourceIds: ReadonlyArray<string | undefined>
  keepFrom: number
  messages: readonly MessageLike[]
}): string | undefined {
  const { sourceIds, messages } = args
  if (!Number.isInteger(args.keepFrom) || sourceIds.length === 0)
    return undefined
  const positions = new Map(messages.map((m, index) => [m.id, index]))
  for (
    let index = Math.min(args.keepFrom, sourceIds.length - 1);
    index >= 0;
    index -= 1
  ) {
    const id = sourceIds[index]
    if (id === undefined) return undefined
    const position = positions.get(id)
    // A hoisted tool image is no message of the thread: step back past it.
    if (position === undefined) continue
    if (position === 0) return undefined
    if (messages[position].role === 'user') return id
  }
  return undefined
}

/** The compaction to store for `result`, whose kept part starts at `boundaryId`. */
export function threadCompactionFrom(args: {
  result: CompactResult
  boundaryId: string
  /** The thread's conversation, as it is shown. */
  conversation: readonly { id: string }[]
  modelId: string
  provider: string
  now?: number
}): ThreadCompaction {
  const above = args.conversation.findIndex((m) => m.id === args.boundaryId)
  return {
    summary: args.result.summary.trim(),
    upToMessageId: args.boundaryId,
    summarizedCount: Math.max(above, 0),
    tokensBefore: args.result.tokensBefore,
    tokensAfter: args.result.tokensAfter,
    modelId: args.modelId,
    provider: args.provider,
    createdAt: args.now ?? Date.now(),
  }
}

/**
 * Whether there is history to compact: at least one user message before the
 * latest one, after the history the request already leaves out.
 */
export function hasCompactableHistory(
  messages: readonly MessageLike[],
  starts: ReadonlyArray<string | undefined>
): boolean {
  const start = laterHistoryStart(messages, starts)
  const from = start ? messages.findIndex((m) => m.id === start) : 0
  let users = 0
  for (let index = Math.max(from, 0); index < messages.length; index += 1) {
    if (messages[index].role === 'user') users += 1
    if (users >= 2) return true
  }
  return false
}

/** The history a retry of the turn the conversation ends with sends: up to and including its user message. */
export function historyToLatestUser<T extends MessageLike>(
  messages: readonly T[]
): T[] {
  const latest = messages.findLastIndex((m) => m.role === 'user')
  return messages.slice(0, latest + 1)
}

/**
 * One automatic compaction per turn: the pre-flight and the thread page's
 * overflow recovery share this, keyed by thread and the user message that
 * started the turn, so a compacted request that overflows again shows the
 * error card instead of compacting in a loop. Module-wide: a thread's chat
 * outlives its page.
 */
const autoCompactedTurns = new Set<string>()

export function autoCompactionKey(
  threadId: string | undefined,
  messages: readonly MessageLike[]
): string | undefined {
  const turn = messages.findLast((m) => m.role === 'user')?.id
  return turn ? `${threadId ?? ''}:${turn}` : undefined
}

/** Records the turn's automatic compaction; `false` when it already had one. */
export function claimAutoCompaction(key: string | undefined): boolean {
  if (!key) return true
  if (autoCompactedTurns.has(key)) return false
  autoCompactedTurns.add(key)
  return true
}

export function hadAutoCompaction(key: string | undefined): boolean {
  return key !== undefined && autoCompactedTurns.has(key)
}

/** For tests. */
export function resetAutoCompactions(): void {
  autoCompactedTurns.clear()
}

/** What the thread page does about a turn that overflowed its window. */
export type OverflowRecovery =
  /** Grow the window and answer again; `to` is the device maximum, when the core measured it. */
  | { kind: 'expand'; to?: number }
  /** Compact the history and answer again. */
  | { kind: 'compact' }
  /** Nothing automatic: the error card offers what is left. */
  | { kind: 'none' }

/**
 * The thread page's side of the one overflow rule, for a turn the engine
 * answered with an overflow (or that ran out of window mid-answer): an engine
 * that reloads in seconds and was measured below its device maximum grows
 * once, straight to it; any other local overflow is compacted, once per turn.
 * Without a measure (an older core) an engine that reloads grows along its
 * ladder as it always did, and the rest are compacted only when the core is
 * not known to lack compaction.
 */
export function planOverflowRecovery(args: {
  providerId: string | undefined
  modelId: string | undefined
  /** The core's measure of the failed request (`transport.lastContextMeasure`). */
  measure:
    | {
        providerId: string
        modelId: string
        resize: string
        windowTokens?: number
        maxWindowTokens?: number
      }
    | undefined
  /** The model's `auto_increase_ctx_len`. */
  autoIncrease: boolean
  /** The turn already had its automatic compaction. */
  compacted: boolean
  /** The core answered the compaction routes with a 404 lately. */
  compactionAbsent: boolean
}): OverflowRecovery {
  const support = contextSupport(args.providerId)
  if (support.resize === undefined) return { kind: 'none' }
  const measure =
    args.measure &&
    args.measure.providerId === args.providerId &&
    args.measure.modelId === args.modelId
      ? args.measure
      : undefined
  const compact: OverflowRecovery =
    args.compacted || args.compactionAbsent
      ? { kind: 'none' }
      : { kind: 'compact' }
  if (!measure) {
    if (support.canExpand && args.autoIncrease) return { kind: 'expand' }
    return compact
  }
  const { windowTokens, maxWindowTokens } = measure
  if (
    measure.resize === 'reload' &&
    support.canExpand &&
    args.autoIncrease &&
    windowTokens !== undefined &&
    maxWindowTokens !== undefined &&
    windowTokens < maxWindowTokens
  ) {
    return { kind: 'expand', to: maxWindowTokens }
  }
  return compact
}

/** A token count the way the app labels context sizes ("28K"), exact below one K. */
export function formatCompactionTokens(tokens: number): string {
  return tokens < 1024
    ? String(Math.max(0, Math.round(tokens)))
    : (formatContextLength(tokens) ?? String(tokens))
}
