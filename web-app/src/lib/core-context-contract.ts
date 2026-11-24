/**
 * Context-window contracts of the core that the chat needs: what a request measures against the
 * window its session serves, and history compaction — summarizing the oldest turns of a chat that
 * no longer fits, so it goes on without reloading the model.
 *
 * A faithful copy of the parts of `@atomic-chat/core/contracts` (`src/contracts/context.ts`) the app
 * uses. The pinned core (0.24.7) does not export them yet; once the app pins the core release that
 * does, delete this file and import the same names from `@atomic-chat/core/contracts` instead.
 * `ContextResizeMode` is mirrored once, in `context-support.ts`, next to `contextResizeMode`.
 */

import type { ContextResizeMode } from '@/lib/context-support'

export type { ContextResizeMode }

/**
 * Where a context plan's numbers come from: the device's memory (`unified` — Apple silicon,
 * `gpu` — a discrete accelerator, `cpu` — system RAM only), the engine's own fit (`engine` — a
 * managed engine's memory rule), or the model alone (`model` — the window the model declares, which
 * the engine runs as is).
 */
export type ContextPlanBasis = 'unified' | 'gpu' | 'cpu' | 'engine' | 'model'

/**
 * The window a model gets on this device when nobody chose one: the largest that fits, never above
 * the window it was trained for. Part of `GET /models/:provider/*modelId/capabilities`.
 */
export interface ContextPlan {
  /** The window a load gets by default. */
  recommendedCtx: number
  /** The largest window the device can hold for this model; a grow never goes past it. */
  maxCtx: number
  /** `{arch}.context_length` or the checkpoint's own maximum, when known. */
  trainedCtx?: number
  /** KV-cache bytes per token of context, when estimated. */
  kvBytesPerToken?: number
  basis: ContextPlanBasis
}

/** Share of the window a compacted prompt aims at, so compaction stays rare. */
export const COMPACTION_TARGET_RATIO = 0.5

/** An OpenAI chat message as far as context handling needs it. */
export interface ContextChatMessage {
  role: string
  content?: unknown
  tool_calls?: unknown
  tool_call_id?: string
  [key: string]: unknown
}

/** `POST /models/:provider/*modelId/context/measure`. */
export interface ContextMeasureRequest {
  messages: ContextChatMessage[]
  tools?: unknown[]
  chat_template_kwargs?: Record<string, unknown>
}

/** What the session's engine counts for a request, and the windows it is measured against. */
export interface ContextMeasureResult {
  promptTokens: number
  /** Counted by the engine's tokenizer; `false` for an estimate (calibrated when the session has answered before). */
  exact: boolean
  /** The window the session serves, when known. */
  windowTokens?: number
  /** The largest window this device can hold for the model (`ContextPlan.maxCtx`), when known. */
  maxWindowTokens?: number
  resize: ContextResizeMode
  /** The engine streams `prompt_progress` when asked with `return_progress`. */
  supportsPromptProgress: boolean
}

/** `POST /models/:provider/*modelId/compact`. */
export interface CompactRequest {
  messages: ContextChatMessage[]
  tools?: unknown[]
  /** Tokens kept free for the answer; the server's default answer reserve when absent. */
  reserveTokens?: number
  /** Share of the window the compacted prompt aims at; {@link COMPACTION_TARGET_RATIO} when absent. */
  targetRatio?: number
}

/** A compaction of a request's history. */
export interface CompactResult {
  /** The summary of the replaced messages, in the conversation's language. */
  summary: string
  /**
   * Index into the request's `messages` of the first message kept as is. Every non-system message
   * before it is replaced by the summary; system messages before it are kept.
   */
  keepFrom: number
  /** How many messages the summary replaces. */
  summarizedCount: number
  tokensBefore: number
  tokensAfter: number
  /** Answered from the summary cache, without asking the model. */
  cached: boolean
}

/** Payload of `session:history-compacted`. */
export interface HistoryCompactedEvent {
  provider: string
  modelId: string
  summarizedMessages: number
  tokensBefore: number
  tokensAfter: number
  cached: boolean
  /** `api` — the public server compacted a client's request; `control` — a client asked for it. */
  source: 'api' | 'control'
}

const SUMMARY_OPEN = '<conversation_summary>'
const SUMMARY_CLOSE = '</conversation_summary>'

/** The block a summary is placed in, inside the system prompt. */
export function summaryBlock(summary: string): string {
  return `${SUMMARY_OPEN}\nThe earlier part of this conversation was summarized to fit the context window:\n${summary.trim()}\n${SUMMARY_CLOSE}`
}

/** Share of the window a request may fill (prompt plus the answer reserve) before it counts as overflowing. */
export const CONTEXT_FIT_RATIO = 0.9

/** What to do about a request: send it as is, grow the window first, or compact the history. */
export type OverflowAction = 'none' | 'expand' | 'compact'

/**
 * The one overflow rule, shared by the app's chat and the public server. A request fits when its
 * prompt plus answer reserve stays within {@link CONTEXT_FIT_RATIO} of the window. One that does not
 * grows the window only on an engine that reloads in seconds (`reload`), only while the window is
 * below the device maximum, and only when the maximum would hold it; every other overflow is
 * compacted. An unknown window is never acted on: the engine's own overflow error is the safety net.
 */
export function decideOverflowAction(input: {
  resize: ContextResizeMode | undefined
  neededTokens: number
  windowTokens: number | undefined
  maxWindowTokens?: number | undefined
}): OverflowAction {
  const { resize, neededTokens, windowTokens, maxWindowTokens } = input
  if (windowTokens === undefined || !(windowTokens > 0)) return 'none'
  if (neededTokens <= windowTokens * CONTEXT_FIT_RATIO) return 'none'
  if (
    resize === 'reload' &&
    maxWindowTokens !== undefined &&
    maxWindowTokens > windowTokens &&
    neededTokens <= maxWindowTokens * CONTEXT_FIT_RATIO
  ) {
    return 'expand'
  }
  return 'compact'
}
