/**
 * Chat-turn telemetry: the single emission point for `chat_request_sent` and
 * `chat_response_received`.
 *
 * Before this module the app could count sends but knew nothing about what came
 * back — no success rate, no latency, no token throughput, no failure reasons.
 * Every send now mints a `turn_id` that both events carry, so a request joins
 * to its outcome in PostHog.
 *
 * PII contract (same as `lib/telemetry.ts`): only enums, ids, numbers,
 * `*_bucket` strings and booleans. Prompt and response text are reported only
 * as coarse length buckets; attachment filenames never leave the device.
 *
 * All property-shaping lives here rather than at the call sites, because the
 * call sites (`custom-chat-transport.ts`, `SetupScreen.tsx`, …) sit under
 * coverage floors in `tests/coverage-floor.json` — logic added there would have
 * to be covered by their own suites. Keep this module pure and testable and
 * keep the call sites to a single unconditional call.
 */

import posthog from 'posthog-js'

import type { Attachment } from '@/types/attachment'
import {
  attachmentExt,
  chatHttpStatus,
  ctxUsedBucket,
  ctxUsedPercent,
  classifyChatFailure,
  finalizeChatTurnOnce,
  lengthBucket,
  loadBackendFromProvider,
  shouldEmitChatFailure,
  sizeBucket,
  toolNameForAnalytics,
  type ChatFailureKind,
} from '@/lib/telemetry'

export type ChatTurnSource = 'chat' | 'agent' | 'regenerate' | 'edit'

export type ChatOutcome =
  | 'success'
  | 'error'
  | 'aborted'
  /** Hit the context limit and the app is auto-continuing from the partial. */
  | 'truncated_continued'
  /** Hit the context limit and stopped (auto-increase disabled). */
  | 'truncated_stopped'

/* ------------------------------------------------------------------ */
/* turn id correlation                                                 */
/* ------------------------------------------------------------------ */

const activeTurnByThread = new Map<string, string>()

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Mint the turn id for a new send and remember it for the matching response. */
export function beginChatTurn(threadId: string): string {
  const turnId = randomId()
  activeTurnByThread.set(threadId, turnId)
  if (activeTurnByThread.size > 200) {
    // Bounded: threads are long-lived but the map only needs the in-flight turn.
    const oldest = activeTurnByThread.keys().next().value
    if (oldest !== undefined && oldest !== threadId)
      activeTurnByThread.delete(oldest)
  }
  return turnId
}

/**
 * The turn id of the in-flight send for this thread. Falls back to a fresh id
 * so a response arriving without a tracked send (regenerate from a restored
 * session, resumed stream) still emits rather than being silently dropped.
 */
export function currentChatTurn(threadId: string): string {
  const existing = activeTurnByThread.get(threadId)
  if (existing) return existing
  return beginChatTurn(threadId)
}

export function endChatTurn(threadId: string): void {
  activeTurnByThread.delete(threadId)
}

/* ------------------------------------------------------------------ */
/* property shaping                                                    */
/* ------------------------------------------------------------------ */

export type AttachmentTelemetry = {
  attachment_count: number
  attachment_kinds: string[]
  attachment_exts: string[]
  attachment_size_bucket: string
  parse_modes: string[]
  injection_modes: string[]
  chunk_count_total: number
}

const uniqueSorted = (values: (string | undefined | null)[]): string[] =>
  [...new Set(values.filter((v): v is string => !!v))].sort()

/**
 * Prefer the already-parsed `fileType` ('pdf', 'docx') over re-deriving it from
 * the filename. Both go through `attachmentExt`'s allow-list, so an unexpected
 * value collapses to 'other' either way — a synthetic filename is used for the
 * `fileType` case so there is exactly one place that decides what is allowed.
 */
const extensionOf = (a: Attachment): string =>
  a.fileType ? attachmentExt(`attachment.${a.fileType}`) : attachmentExt(a.name)

/**
 * Shape of the attached files — kinds, extensions, total size, how documents
 * were folded in. Reads `fileType`/`name` only to derive an allow-listed
 * extension; the name itself is never emitted.
 */
export function attachmentTelemetry(
  attachments: readonly Attachment[] | null | undefined
): AttachmentTelemetry {
  const list = attachments ?? []
  const totalBytes = list.reduce((sum, a) => sum + (a.size ?? 0), 0)
  return {
    attachment_count: list.length,
    attachment_kinds: uniqueSorted(list.map((a) => a.type)),
    attachment_exts: uniqueSorted(list.map(extensionOf)),
    attachment_size_bucket: list.length > 0 ? sizeBucket(totalBytes) : 'unknown',
    parse_modes: uniqueSorted(list.map((a) => a.parseMode)),
    injection_modes: uniqueSorted(list.map((a) => a.injectionMode)),
    chunk_count_total: list.reduce((sum, a) => sum + (a.chunkCount ?? 0), 0),
  }
}

/** Count of fenced code blocks in a response — a proxy for "was this a coding
 * answer" that never carries the code itself. */
export function codeBlockCount(text?: string | null): number {
  if (!text) return 0
  const fences = text.match(/```/g)
  return fences ? Math.floor(fences.length / 2) : 0
}

export type ContextTelemetry = {
  ctx_len: number | null
  ctx_used_pct_bucket: string
}

export function contextTelemetry(
  tokens?: number | null,
  ctxLen?: number | null
): ContextTelemetry {
  return {
    ctx_len: ctxLen ?? null,
    ctx_used_pct_bucket: ctxUsedBucket(ctxUsedPercent(tokens, ctxLen)),
  }
}

export type ToolTelemetry = {
  tool_call_count: number
  tool_names: string[]
  has_rag: boolean
  has_mcp: boolean
}

export function toolTelemetry(
  toolNames: readonly string[] | null | undefined,
  ragToolNames?: ReadonlySet<string> | null,
  mcpToolNames?: ReadonlySet<string> | null
): ToolTelemetry {
  const list = toolNames ?? []
  // Everything we ship is reported by name; user-configured MCP tools are
  // hashed by `toolNameForAnalytics`.
  const builtin = new Set(ragToolNames ?? [])
  return {
    tool_call_count: list.length,
    tool_names: uniqueSorted(
      list.map((name) => toolNameForAnalytics(name, builtin))
    ),
    has_rag: list.some((name) => builtin.has(name)),
    has_mcp: list.some((name) => mcpToolNames?.has(name) ?? false),
  }
}

/* ------------------------------------------------------------------ */
/* assistant message → properties                                      */
/* ------------------------------------------------------------------ */

/**
 * Structural shape of an AI SDK `UIMessage`, narrowed to what telemetry reads.
 * Deliberately not the SDK type: this module stays free of the chat stack so
 * it can be unit-tested with plain objects.
 */
export type TelemetryMessageLike = {
  parts?: readonly { type: string; text?: string }[]
  // `UIMessage` leaves its metadata generic as `unknown`; keep the parameter
  // assignable and narrow to a record here instead of at every call site.
  metadata?: unknown
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/**
 * Everything derivable from a finished assistant message: the shape of the
 * answer (buckets and counts only, never text), the tools it invoked, and the
 * timing/usage numbers the transport already attached as message metadata.
 */
export function responseShapeFromMessage(
  message: TelemetryMessageLike | null | undefined,
  ragToolNames?: ReadonlySet<string> | null,
  mcpToolNames?: ReadonlySet<string> | null
): Record<string, unknown> {
  const parts = message?.parts ?? []
  const meta = (message?.metadata ?? {}) as Record<string, unknown>

  const text = parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('')
  const reasoning = parts
    .filter((p) => p.type === 'reasoning')
    .map((p) => p.text ?? '')
    .join('')
  const toolNames = parts
    .filter((p) => p.type.startsWith('tool-'))
    .map((p) => p.type.slice('tool-'.length))

  const usage = (meta.usage ?? {}) as Record<string, unknown>
  const speed = (meta.tokenSpeed ?? {}) as Record<string, unknown>

  return {
    response_len_bucket: lengthBucket(text.length),
    has_reasoning: reasoning.length > 0,
    reasoning_len_bucket: lengthBucket(reasoning.length),
    code_block_count: codeBlockCount(text),
    ...toolTelemetry(toolNames, ragToolNames, mcpToolNames),

    finish_reason: (meta.finishReason as string | undefined) ?? null,
    ttft_ms: num(meta.ttftMs),
    total_duration_ms: num(meta.activityDurationMs),
    decode_duration_ms: num(speed.durationMs),
    tps: num(speed.tokenSpeed),

    tokens_in: num(usage.inputTokens),
    tokens_out: num(usage.outputTokens),
    tokens_total: num(usage.totalTokens),
    draft_tokens_total: num(speed.draftTokensTotal),
    draft_tokens_accepted: num(speed.draftTokensAccepted),
  }
}

/* ------------------------------------------------------------------ */
/* agent run → properties                                              */
/* ------------------------------------------------------------------ */

/** Structural shape of `AgentRunState`, narrowed to what telemetry reads. */
export type TelemetryAgentRunLike = {
  startedAtMs?: number
  finishedAtMs?: number
  trace?: {
    assistantText?: string
    reasoning?: Record<number, string>
    tools?: readonly { call?: { tool?: string } }[]
    error?: unknown
    finishReason?: string
    stepCount?: number
  }
}

/**
 * Agent turns run over IPC rather than the chat transport, so none of the
 * stream metadata exists for them. Map what the run trace does record onto the
 * same event shape, so agent and chat turns are comparable in one funnel.
 */
export function agentOutcome(finishReason?: string | null): ChatOutcome {
  if (finishReason === 'cancelled') return 'aborted'
  if (finishReason === 'failed') return 'error'
  return 'success'
}

export function agentResponseShape(
  run: TelemetryAgentRunLike | null | undefined,
  ragToolNames?: ReadonlySet<string> | null,
  mcpToolNames?: ReadonlySet<string> | null
): Record<string, unknown> {
  const trace = run?.trace ?? {}
  const text = trace.assistantText ?? ''
  const reasoning = Object.values(trace.reasoning ?? {}).join('')
  const duration =
    run?.startedAtMs != null && run?.finishedAtMs != null
      ? Math.max(0, run.finishedAtMs - run.startedAtMs)
      : null

  return {
    response_len_bucket: lengthBucket(text.length),
    has_reasoning: reasoning.length > 0,
    reasoning_len_bucket: lengthBucket(reasoning.length),
    code_block_count: codeBlockCount(text),
    ...toolTelemetry(
      (trace.tools ?? [])
        .map((t) => t.call?.tool)
        .filter((name): name is string => !!name),
      ragToolNames,
      mcpToolNames
    ),
    finish_reason: trace.finishReason ?? null,
    total_duration_ms: duration,
    agent_step_count: trace.stepCount ?? null,
  }
}

/* ------------------------------------------------------------------ */
/* emission                                                            */
/* ------------------------------------------------------------------ */

/** Drop undefined so PostHog property schemas stay clean. */
function compact(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

export type ChatRequestProps = {
  turn_id: string
  thread_id: string
  source: ChatTurnSource
  model_id?: string | null
  provider?: string | null
  turn_index?: number
  prompt_len_bucket?: string
  is_agent_mode?: boolean
  agent_skill?: string | null
  tools_enabled_count?: number
} & Partial<AttachmentTelemetry> &
  Partial<ContextTelemetry> &
  Partial<Pick<ToolTelemetry, 'has_rag' | 'has_mcp'>>

export function captureChatRequest(props: ChatRequestProps): void {
  try {
    posthog.capture(
      'chat_request_sent',
      compact({
        ...props,
        has_attachments: (props.attachment_count ?? 0) > 0,
        backend: loadBackendFromProvider(props.provider),
      })
    )
  } catch (err) {
    console.debug('chat_request_sent telemetry failed:', err)
  }
}

export type ChatResponseProps = {
  turn_id: string
  thread_id: string
  source: ChatTurnSource
  outcome: ChatOutcome
  finish_reason?: string | null
  error?: unknown
  model_id?: string | null
  provider?: string | null
  turn_index?: number

  ttft_ms?: number | null
  total_duration_ms?: number | null
  decode_duration_ms?: number | null
  tps?: number | null

  tokens_in?: number | null
  tokens_out?: number | null
  tokens_total?: number | null
  draft_tokens_total?: number | null
  draft_tokens_accepted?: number | null

  ctx_overflow?: boolean
  ctx_auto_increased?: boolean

  response_len_bucket?: string
  has_reasoning?: boolean
  reasoning_len_bucket?: string
  code_block_count?: number
} & Partial<AttachmentTelemetry> &
  Partial<ContextTelemetry> &
  Partial<ToolTelemetry> &
  Record<string, unknown>

/**
 * Emit exactly one `chat_response_received` per turn.
 *
 * Deduped on `turn_id` because `onFinish` fires more than once per message and
 * can race the error path. Failures are additionally throttled per
 * (model, error_kind) so a backend stuck in a retry loop cannot dominate
 * event-weighted metrics — matching how `model_load` failures are handled.
 */
export function captureChatResponse(props: ChatResponseProps): void {
  try {
    const { error, ...rest } = props
    const errorKind: ChatFailureKind | undefined =
      props.outcome === 'error' ? classifyChatFailure(error) : undefined

    if (!finalizeChatTurnOnce(props.turn_id)) return
    if (
      errorKind !== undefined &&
      !shouldEmitChatFailure(props.model_id, errorKind)
    )
      return

    posthog.capture(
      'chat_response_received',
      compact({
        ...rest,
        error_kind: errorKind ?? null,
        http_status: errorKind !== undefined ? chatHttpStatus(error) : null,
        backend: loadBackendFromProvider(props.provider),
      })
    )
  } catch (err) {
    console.debug('chat_response_received telemetry failed:', err)
  } finally {
    endChatTurn(props.thread_id)
  }
}

export { lengthBucket }
