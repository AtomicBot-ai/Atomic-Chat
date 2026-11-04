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

import type { Attachment } from '@/types/attachment'
import { queuedCapture } from '@/lib/telemetry-queue'
import {
  attachmentExt,
  chatHttpStatus,
  ctxUsedBucket,
  ctxUsedPercent,
  execBackendForModel,
  classifyChatFailure,
  finalizeChatTurnOnce,
  lastLoadIdForModel,
  lengthBucket,
  loadBackendFromProvider,
  normalizeModelId,
  sizeBucket,
  toolNameForAnalytics,
  type ChatFailureKind,
} from '@/lib/telemetry'

export type ChatTurnSource =
  | 'chat'
  | 'agent'
  | 'regenerate'
  | 'edit'
  /**
   * A regenerate the app started on its own (engine recovery), kept apart
   * from `regenerate` so user retries and automatic ones count separately.
   */
  | 'auto_retry'

/**
 * Which pipeline actually served the turn. After the chat/agent merge the
 * engine is a routing outcome, not a user choice — `route_reason` records why
 * (see `RouteReason` in `lib/agent-route.ts`), so fallback traffic stays
 * observable while the legacy pipeline is retired.
 */
export type ChatEngine = 'agent-ipc' | 'chat-transport'

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

/**
 * What is known about one send while it runs: the ids both events carry, and
 * the clock the failure events read their timings from.
 */
type TurnRecord = {
  turnId: string
  threadId: string
  /**
   * Fresh for every send, regenerate, edit and retry, and carried by its
   * request and its response, so attempts count and join on their own.
   */
  attemptId: string
  /** When the send started; null for a turn minted at response time. */
  startedAtMs: number | null
  /** When the first generated output reached the chat, if any did. */
  firstOutputAtMs?: number
  /** Chat updates from the first output on: the chunks the reply arrived in. */
  outputChunks: number
  /** Whether a stream was observed at all, so 0 chunks means "none came". */
  observed: boolean
  stopObserving?: () => void
}

const MAX_TRACKED_TURNS = 200

const activeTurnByThread = new Map<string, string>()
/** The turn each thread last reported, until its next send. */
const endedTurnByThread = new Map<string, string>()
const turnRecords = new Map<string, TurnRecord>()

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Insert-or-refresh with oldest-first eviction, like the throttles. */
function boundedSet<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  onEvict?: (value: V) => void
): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_TRACKED_TURNS) {
    const oldest = map.keys().next()
    if (oldest.done) break
    onEvict?.(map.get(oldest.value) as V)
    map.delete(oldest.value)
  }
}

function stopObserving(record: TurnRecord | undefined): void {
  record?.stopObserving?.()
  if (record) record.stopObserving = undefined
}

function startTurn(threadId: string, startedAtMs: number | null): TurnRecord {
  // A send that replaces one still in flight takes over its stream.
  const previous = activeTurnByThread.get(threadId)
  if (previous) stopObserving(turnRecords.get(previous))
  const record: TurnRecord = {
    turnId: randomId(),
    threadId,
    attemptId: randomId(),
    startedAtMs,
    outputChunks: 0,
    observed: false,
  }
  boundedSet(turnRecords, record.turnId, record, stopObserving)
  boundedSet(activeTurnByThread, threadId, record.turnId)
  endedTurnByThread.delete(threadId)
  return record
}

/** Mint the turn id for a new send and remember it for the matching response. */
export function beginChatTurn(threadId: string): string {
  return startTurn(threadId, Date.now()).turnId
}

/**
 * The turn id of the in-flight send for this thread.
 *
 * Once that turn is reported this keeps returning it until the next send, so
 * a second report of the same turn dedupes onto it. It used to mint a fresh
 * id instead: the AI SDK calls `onError` and then `onFinish({ isError })` for
 * one failure, and the finish became a phantom turn — a `success` with no
 * request after every error.
 *
 * Only a thread with no tracked send at all (a stream resumed in a restored
 * session) gets a fresh id, so its response still emits.
 */
export function currentChatTurn(threadId: string): string {
  return (
    activeTurnByThread.get(threadId) ??
    endedTurnByThread.get(threadId) ??
    startTurn(threadId, null).turnId
  )
}

/**
 * Release the thread's in-flight turn. With `turnId`, only when that is the
 * in-flight one, so a late report of an older turn cannot end a newer send.
 */
export function endChatTurn(threadId: string, turnId?: string): void {
  const active = activeTurnByThread.get(threadId)
  if (!active || (turnId !== undefined && turnId !== active)) return
  activeTurnByThread.delete(threadId)
  boundedSet(endedTurnByThread, threadId, active)
  stopObserving(turnRecords.get(active))
}

/* ------------------------------------------------------------------ */
/* stream observation (failure timings)                                */
/* ------------------------------------------------------------------ */

/**
 * Structural slice of the AI SDK `Chat` that the observer reads. The
 * messages callback is the same hook `useChat` renders from; registered here
 * without a throttle, it runs once per streamed update.
 */
export type ChatStreamLike = {
  readonly 'lastMessage'?:
    | (TelemetryMessageLike & { id?: string; role?: string })
    | undefined
  '~registerMessagesCallback'?: (
    onChange: () => void,
    throttleWaitMs?: number
  ) => () => void
}

/** Text, reasoning, a tool call or a file: anything the model generated. */
function hasGeneratedOutput(message: TelemetryMessageLike): boolean {
  return (message.parts ?? []).some((part) =>
    part.type === 'text' || part.type === 'reasoning'
      ? (part.text ?? '').trim() !== ''
      : part.type === 'file' ||
        part.type === 'dynamic-tool' ||
        part.type.startsWith('tool-')
  )
}

/**
 * Note when the attempt's first output arrives and how many updates follow.
 *
 * A failed turn finishes without the `finish` part the transport hangs its
 * timings and usage on, so `chat_response_received` errors carried null
 * `ttft_ms`, `tokens_out` and `total_duration_ms`, and a failure before the
 * first token could not be told from one mid-stream. The first output here is
 * the same event the transport's `ttft_ms` starts its clock on (the first
 * text or reasoning delta), seen one hop later.
 */
function observeChatStream(record: TurnRecord, stream: ChatStreamLike): void {
  const register = stream['~registerMessagesCallback']
  if (typeof register !== 'function') return
  stopObserving(record)
  // A message that was already last when the send started is history, not
  // this attempt's reply (a regenerate starts with the old answer in place).
  const baselineId = stream.lastMessage?.id
  try {
    record.stopObserving = register.call(stream, () => {
      const last = stream.lastMessage
      if (!last || last.role !== 'assistant' || last.id === baselineId) return
      if (record.firstOutputAtMs === undefined) {
        if (!hasGeneratedOutput(last)) return
        record.firstOutputAtMs = Date.now()
      }
      record.outputChunks += 1
    })
    record.observed = true
  } catch (err) {
    console.debug('chat stream observation failed:', err)
  }
}

export type FailurePhase = 'before_first_token' | 'mid_stream'

/** Did the partial reply hold any output, judged from its shape alone? */
function shapeShowsOutput(props: Record<string, unknown>): boolean {
  const len = props.response_len_bucket
  return (
    (typeof len === 'string' && len !== 'empty' && len !== 'unknown') ||
    props.has_reasoning === true ||
    (typeof props.tool_call_count === 'number' && props.tool_call_count > 0)
  )
}

/**
 * `phase`, and the timings a finished reply would have carried, for a turn
 * that failed or was stopped. Values the caller already has win; the rest
 * come from the attempt's own clock, which starts at the send.
 */
function failureTiming(
  record: TurnRecord | undefined,
  props: Record<string, unknown>,
  now: number
): Record<string, unknown> {
  const started = record?.startedAtMs ?? null
  const firstOutput = record?.firstOutputAtMs
  const sawOutput = firstOutput !== undefined || shapeShowsOutput(props)
  const phase: FailurePhase = sawOutput ? 'mid_stream' : 'before_first_token'
  const given = (key: string) =>
    typeof props[key] === 'number' ? (props[key] as number) : null
  return {
    phase,
    ttft_ms:
      given('ttft_ms') ??
      (started !== null && firstOutput !== undefined
        ? Math.max(0, firstOutput - started)
        : null),
    total_duration_ms:
      given('total_duration_ms') ??
      (started !== null ? Math.max(0, now - started) : null),
    output_chunk_count: record?.observed ? record.outputChunks : null,
  }
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

/**
 * Why a send never became a request.
 *
 * Only `no_model` is emitted today. The other early returns in the composer are
 * either noise (an empty prompt is a stray Enter) or already visible elsewhere,
 * and this event exists to size one specific wall.
 */
export type ChatBlockReason = 'no_model'

const blockThrottle = new Map<ChatBlockReason, number>()
const BLOCK_THROTTLE_MS = 60_000

/**
 * A user reached the chat, typed, pressed Enter, and got a hint instead of a
 * response — because there is no model to answer with.
 *
 * This path emitted nothing at all: the composer returns before anything
 * downstream captures a turn, so the single most common first-run dead end was
 * invisible. Pairing it with what the user does next is the point.
 *
 * Throttled per reason: holding Enter must not turn one user into a spike.
 */
export function captureChatSendBlocked(props: {
  reason: ChatBlockReason
  thread_id?: string | null
  is_agent_mode?: boolean
  had_local_model_on_disk?: boolean
  had_cloud_key?: boolean
}): void {
  try {
    const now = Date.now()
    const last = blockThrottle.get(props.reason)
    if (last !== undefined && now - last < BLOCK_THROTTLE_MS) return
    blockThrottle.set(props.reason, now)

    const { reason, ...rest } = props
    queuedCapture(
      'chat_send_blocked',
      compact({ ...rest, block_reason: reason })
    )
  } catch (err) {
    console.debug('chat_send_blocked telemetry failed:', err)
  }
}

/** Test seam — the throttle is module state and outlives a single test. */
export function resetChatSendBlockThrottleForTests(): void {
  blockThrottle.clear()
}

export type ChatRequestProps = {
  turn_id: string
  thread_id: string
  source: ChatTurnSource
  engine?: ChatEngine
  route_reason?: string
  model_id?: string | null
  provider?: string | null
  turn_index?: number
  prompt_len_bucket?: string
  is_agent_mode?: boolean
  agent_skill?: string | null
  tools_enabled_count?: number
  /** Estimated token cost of the tool definitions actually sent. */
  tools_tokens_estimate?: number | null
  /** That cost as a fraction of the configured context window. */
  tools_ctx_share?: number | null
  /** How many MCP servers contribute an outsized share of that cost. */
  tools_heavy_servers?: number
} & Partial<AttachmentTelemetry> &
  Partial<ContextTelemetry> &
  Partial<Pick<ToolTelemetry, 'has_rag' | 'has_mcp'>>

/**
 * The record for a turn id: the one `beginChatTurn` minted, or a new one for
 * an id that did not come from it, so every request still gets an attempt.
 */
function recordFor(turnId: string, threadId: string): TurnRecord {
  const existing = turnRecords.get(turnId)
  if (existing) return existing
  const record: TurnRecord = {
    turnId,
    threadId,
    attemptId: randomId(),
    startedAtMs: Date.now(),
    outputChunks: 0,
    observed: false,
  }
  boundedSet(turnRecords, turnId, record, stopObserving)
  return record
}

/**
 * Time the reply to the thread's in-flight send from the thread's AI SDK
 * `Chat`, so a failure reports when (and whether) output arrived. Call right
 * after `captureChatRequest`; a thread with no send in flight is ignored.
 */
export function observeChatTurn(
  threadId: string,
  stream: ChatStreamLike | null | undefined
): void {
  try {
    const turnId = activeTurnByThread.get(threadId)
    const record = turnId ? turnRecords.get(turnId) : undefined
    if (record && stream) observeChatStream(record, stream)
  } catch (err) {
    console.debug('chat stream observation failed:', err)
  }
}

export function captureChatRequest(props: ChatRequestProps): void {
  try {
    const record = recordFor(props.turn_id, props.thread_id)
    queuedCapture(
      'chat_request_sent',
      compact({
        ...props,
        attempt_id: record.attemptId,
        model_id: normalizeModelId(props.model_id),
        has_attachments: (props.attachment_count ?? 0) > 0,
        backend: loadBackendFromProvider(props.provider),
        // Joins the request to the `model_load` that put this model in
        // memory; null for cloud models and before any load this session.
        last_load_id: lastLoadIdForModel(props.model_id, props.provider),
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
  engine?: ChatEngine
  route_reason?: string
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
 * Deduped on `turn_id` only, because `onFinish` fires more than once per
 * message and can race the error path. Failures used to be throttled per
 * (model, error_kind) as well, after the turn was already marked reported: a
 * dropped failure left its request without a response for good, so the error
 * rate read low exactly where errors repeat. Every request now gets its
 * response; volume from a stuck device is bounded by its requests, and
 * failure rates are counted per device anyway. The `model_load` crash-loop
 * throttle is separate and stays.
 */
export function captureChatResponse(props: ChatResponseProps): void {
  try {
    const { error, ...rest } = props
    const errorKind: ChatFailureKind | undefined =
      props.outcome === 'error'
        ? classifyChatFailure(error, props.provider)
        : undefined

    if (!finalizeChatTurnOnce(props.turn_id)) return

    const record = turnRecords.get(props.turn_id)
    const failed = props.outcome === 'error' || props.outcome === 'aborted'

    queuedCapture(
      'chat_response_received',
      compact({
        ...rest,
        ...(failed ? failureTiming(record, rest, Date.now()) : {}),
        attempt_id: record?.attemptId ?? null,
        model_id: normalizeModelId(props.model_id),
        // What computed the answer. Null for remote providers — the whole
        // reason `active_backend`, a device-level super-property, could not be
        // used for this: it rode along on Pollinations and OpenAI responses
        // too, and inverted the CPU-versus-GPU comparison.
        exec_backend: execBackendForModel(props.model_id, props.provider),
        error_kind: errorKind ?? null,
        http_status: errorKind !== undefined ? chatHttpStatus(error) : null,
        backend: loadBackendFromProvider(props.provider),
      })
    )
  } catch (err) {
    console.debug('chat_response_received telemetry failed:', err)
  } finally {
    endChatTurn(props.thread_id, props.turn_id)
  }
}

export { lengthBucket }
