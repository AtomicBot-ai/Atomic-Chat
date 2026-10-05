import type { UIMessage } from '@ai-sdk/react'
import { estimateTokens } from './prompt-size'

/**
 * Auto-compaction, the way the coding agents (Claude Code, Codex, OpenCode)
 * do it: when a prompt would overflow the context window and the window
 * cannot grow any further, the older part of the conversation is summarized
 * into a structured brief by the model itself, and the request is rebuilt as
 * `[summary, recent messages...]`. The thread history on disk is never
 * rewritten — compaction only shapes what goes out in the request.
 */

/** Share of the context window kept as verbatim recent messages. */
export const COMPACTION_TAIL_SHARE = 0.25
/** Output budget for the summarizer call itself. */
export const COMPACTION_SUMMARY_MAX_TOKENS = 1200
/** The tail never shrinks below this many messages. */
export const COMPACTION_MIN_TAIL_MESSAGES = 2
/** Compaction needs at least this many older messages to be worth a call. */
export const COMPACTION_MIN_HEAD_MESSAGES = 2

export const COMPACTION_HISTORY_PREFIX =
  'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier part of the conversation.'

/**
 * `auto_compaction` of a model; defaults to on. Pairs with
 * `auto_increase_ctx_len`: the growth ladder runs first because it keeps
 * full fidelity, compaction only fires when the ladder cannot help.
 */
export function readAutoCompaction(
  model:
    | {
        settings?: {
          auto_compaction?: { controller_props?: { value?: unknown } }
        }
      }
    | null
    | undefined
): boolean {
  const raw = model?.settings?.auto_compaction?.controller_props?.value
  return typeof raw === 'boolean' ? raw : true
}

/** Serialized text content of a UI message, for token estimation. */
export function uiMessageText(message: UIMessage): string {
  return message.parts
    .map((part) => {
      const typed = part as {
        type?: unknown
        text?: unknown
        input?: unknown
        output?: unknown
        state?: unknown
      }
      if (typeof typed.text === 'string') return typed.text
      if (typed.type === 'dynamic-tool') {
        return JSON.stringify({ input: typed.input, output: typed.output })
      }
      if (typeof typed.type === 'string' && typed.type.startsWith('tool-')) {
        return JSON.stringify({ input: typed.input, output: typed.output })
      }
      if (typed.type === 'file') return ''
      return ''
    })
    .filter((text) => text.length > 0)
    .join('\n')
}

/** Token estimate for one UI message, template overhead included. */
export function estimateUIMessageTokens(message: UIMessage): number {
  return estimateTokens(uiMessageText(message)) + 4
}

/**
 * True when the message carries tool results. A compaction boundary must
 * never separate a tool result from the call that produced it: the tail is
 * sent as real messages, and an orphan result is rejected by providers.
 */
export function hasToolResultParts(message: UIMessage): boolean {
  return message.parts.some((part) => {
    const type = (part as { type?: unknown }).type
    if (typeof type !== 'string') return false
    if (type === 'dynamic-tool') {
      return (part as { output?: unknown }).output !== undefined
    }
    if (!type.startsWith('tool-')) return false
    const tool = part as { output?: unknown; state?: unknown }
    return (
      tool.output !== undefined || tool.state === 'output-available'
    )
  })
}

/**
 * Index of the first message kept verbatim (the tail). Everything before it
 * is summarized. Returns -1 when there is nothing worth compacting: the
 * conversation is too short, or the tail budget already covers it all.
 *
 * The walk keeps the newest messages whose estimated tokens fit
 * `tailBudgetTokens`, then backs up while the boundary message carries tool
 * results so no call ends up in the summarized head with its result in the
 * tail.
 */
export function selectCompactionBoundary(
  messages: readonly UIMessage[],
  opts: {
    tailBudgetTokens: number
    minTailMessages?: number
    minHeadMessages?: number
  }
): number {
  const minTail = Math.max(1, opts.minTailMessages ?? COMPACTION_MIN_TAIL_MESSAGES)
  const minHead = opts.minHeadMessages ?? COMPACTION_MIN_HEAD_MESSAGES

  let boundary = messages.length
  let acc = 0
  while (boundary > 0 && acc < opts.tailBudgetTokens) {
    boundary -= 1
    acc += estimateUIMessageTokens(messages[boundary])
  }
  // A tail budget of zero (or a tiny one) can land on the last message only;
  // keep at least `minTail` messages verbatim.
  boundary = Math.min(boundary, messages.length - minTail)

  while (boundary > 0 && hasToolResultParts(messages[boundary])) {
    boundary -= 1
  }

  if (boundary < minHead || boundary > messages.length - minTail) return -1
  return boundary
}

/** The structured brief prompt. Adapted from the Claude Code compaction prompt. */
export function buildCompactionPrompt(args: {
  system?: string
  head: readonly UIMessage[]
}): string {
  const transcript = args.head
    .map((message) => {
      const role = message.role === 'user' ? 'User' : 'Assistant'
      return `${role}: ${uiMessageText(message)}`
    })
    .join('\n\n')
  const system = args.system?.trim()
    ? `The conversation's active instructions (a system prompt) are reproduced first so the summary can preserve them:\n<system_prompt>\n${args.system.trim()}\n</system_prompt>\n\n`
    : ''

  return `${system}You are summarizing the earlier part of a conversation so it can continue in a shorter context window. Your summary replaces the messages it covers; the recent messages stay verbatim. Write it so work resumes without any loss of continuity.

Produce exactly these sections, each concise but information-dense:

1. Primary Request and Intent: what the user asked for, in their terms, including constraints and corrections they made along the way.
2. Key Context: concepts, decisions, preferences, and facts the continuation depends on.
3. Files, Links and Artifacts: every file path, URL, command, or artifact mentioned, with a one-line note of what was done or decided about it.
4. Errors and Fixes: errors hit and how they were resolved, or why they remain open.
5. Pending Work: explicitly unfinished tasks and open questions.
6. Current State: what was happening immediately before the most recent messages, so work can resume mid-stream.
7. User Messages: a numbered list of the user's asks, verbatim where short.

Rules:
- Use only information from the conversation. Never invent details.
- Preserve exact identifiers: file paths, function names, setting keys, URLs, numbers.
- Write the summary in the conversation's dominant language.
- Output only the summary. No introductions, no closing remarks.

<conversation_to_summarize>
${transcript}
</conversation_to_summarize>`
}

/** The request-time replacement for the summarized head. */
export function buildCompactionSummaryMessage(
  summary: string,
  id = `compaction-${Date.now()}`
): UIMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text: `${COMPACTION_HISTORY_PREFIX}\n\n${summary.trim()}` }],
    metadata: { compaction: true },
  }
}

/** A recorded compaction, for the thread marker and diagnostics. */
export type CompactionEvent = {
  /** UI message id of the first message kept verbatim. */
  boundaryMessageId: string
  /** How many older messages the summary replaced. */
  compactedMessages: number
  /** Estimated tokens the rebuilt request no longer carries. */
  estimatedTokensSaved: number
  summary: string
  createdAt: number
}
