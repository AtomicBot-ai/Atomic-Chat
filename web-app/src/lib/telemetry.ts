/**
 * Shared PostHog telemetry helpers (ATO-108 / ATO-109 / ATO-111).
 *
 * All values produced here obey the epic's PII contract: only enums, ids,
 * numbers, `*_bucket` strings and booleans. No prompt/response text, no file
 * paths, no usernames, no HF/API tokens, no GPU serials/UUIDs.
 */

import {
  AUDIO_EXTENSIONS,
  DOCUMENT_EXTENSIONS,
  IMAGE_EXTENSIONS,
} from '@/containers/chatInput/classifyDroppedPaths'
import {
  isContextLimitError,
  isModelAccessError,
  isOutOfMemoryError,
} from '@/utils/error'

export function getAnalyticsPlatform(): string {
  if (IS_MACOS) return 'macos'
  if (IS_WINDOWS) return 'windows'
  if (IS_LINUX) return 'linux'
  if (IS_IOS) return 'ios'
  if (IS_ANDROID) return 'android'
  return 'unknown'
}

export type DownloadStatus = 'started' | 'completed' | 'failed' | 'cancelled'

export type DownloadKind = 'model' | 'gpu_backend' | 'companion_artifact'

export type DownloadFailureReason =
  | 'http_404'
  | 'http_401_auth'
  | 'http_other'
  | 'checksum_mismatch'
  | 'size_mismatch'
  | 'disk_io'
  | 'network'
  | 'cancelled'
  | 'path_guard'
  | 'unknown'

export type OomSubtype = 'cuda' | 'vulkan' | 'metal' | 'host_ram' | 'unknown'

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'none'

export type CpuAvxLevel = 'none' | 'avx' | 'avx2' | 'avx512'

export type LoadBackend =
  | 'llamacpp'
  | 'llamacpp-upstream'
  | 'mlx'
  | 'foundation-models'
  | 'unknown'

const STDERR_TAIL_BYTES = 2048

/** Extract a quantization token from a model id (e.g. `Q4_K_M`, `IQ4_XS`, `4bit`). */
export function quantFromModelId(modelId?: string | null): string | null {
  if (!modelId) return null
  const match = modelId.match(
    /\b(IQ\d+_[A-Z0-9]+|Q\d+_[A-Z0-9_]+|Q\d+|MXFP\d+|\d+bit|bf16|fp16|fp8|f16|f32)\b/i
  )
  return match ? match[1] : null
}

/** Coarse size bucket so we never ship an exact byte fingerprint. */
export function sizeBucket(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return 'unknown'
  const gb = bytes / 1024 ** 3
  if (gb < 0.5) return 'lt_500mb'
  if (gb < 2) return '500mb_2gb'
  if (gb < 5) return '2_5gb'
  if (gb < 10) return '5_10gb'
  if (gb < 20) return '10_20gb'
  if (gb < 50) return '20_50gb'
  return 'gt_50gb'
}

/** Parse an `HTTP status NNN` token out of a stringly-typed download error. */
export function parseHttpStatus(err?: string | null): number | null {
  if (!err) return null
  const match = err.match(/HTTP status (\d{3})/i)
  return match ? parseInt(match[1], 10) : null
}

/** Classify a stringly-typed download error into a stable enum. */
export function classifyDownloadFailure(err?: string | null): DownloadFailureReason {
  if (!err) return 'unknown'
  const e = err.toLowerCase()
  if (/\b(abort|aborted|cancel|cancelled|canceled|stopped|interrupt)\b/.test(e))
    return 'cancelled'

  const status = parseHttpStatus(err)
  if (status === 404) return 'http_404'
  if (status === 401 || status === 403) return 'http_401_auth'
  if (status != null) return 'http_other'

  if (e.includes('hash verification')) return 'checksum_mismatch'
  if (e.includes('size verification')) return 'size_mismatch'
  if (
    e.includes('no such file') ||
    e.includes('permission denied') ||
    e.includes('disk') ||
    e.includes('io error') ||
    e.includes('os error')
  )
    return 'disk_io'
  if (
    e.includes('path') &&
    (e.includes('guard') ||
      e.includes('invalid') ||
      e.includes('outside') ||
      e.includes('traversal'))
  )
    return 'path_guard'
  if (
    e.includes('network') ||
    e.includes('connection') ||
    e.includes('dns') ||
    e.includes('timed out') ||
    e.includes('timeout') ||
    e.includes('failed to download')
  )
    return 'network'
  return 'unknown'
}

/** Map a download task/model id + type to the `download_kind` enum. */
export function downloadKind(
  idOrTask?: string | null,
  downloadType?: string | null
): DownloadKind {
  const id = (idOrTask ?? '').toLowerCase()
  if (id.includes('cudart')) return 'companion_artifact'
  if (downloadType === 'Backend' || id.includes('llamacpp-backend'))
    return 'gpu_backend'
  return 'model'
}

/** Best-effort OOM device classification from a sanitized stderr tail. */
export function oomSubtype(details?: string | null): OomSubtype {
  if (!details) return 'unknown'
  const d = details.toLowerCase()
  if (d.includes('cuda')) return 'cuda'
  if (d.includes('vulkan') || d.includes('vk_error')) return 'vulkan'
  if (d.includes('metal') || d.includes('iogpu') || d.includes('mtl')) return 'metal'
  if (d.includes('host') || d.includes('system memory') || d.includes('requires more ram'))
    return 'host_ram'
  return 'unknown'
}

/** Parse the projector type out of a `unknown projector type: X` stderr line. */
export function mmprojProjectorType(details?: string | null): string | null {
  if (!details) return null
  const match = details.match(/unknown projector type:\s*([A-Za-z0-9_]+)/i)
  return match ? match[1] : null
}

/**
 * Sensitive query-parameter names whose *values* must be redacted while the
 * parameter name and the rest of the URL/path are preserved (ATO-113 rule 3).
 */
const SENSITIVE_QUERY_KEYS =
  'token|key|api_key|apikey|auth|secret|password|access_token|refresh_token|sig|signature'

/**
 * Scrub the PII classes the epic forbids: usernames in paths, credentials in
 * proxy URLs, HF/API tokens, Bearer tokens, and the values of sensitive
 * query parameters. Path structure, folder names, and parameter names are
 * otherwise preserved (needed for debugging).
 */
export function scrubPii(text: string): string {
  return text
    .replace(/(\/(?:Users|home)\/)[^/\s]+/g, '$1<redacted>')
    .replace(/([A-Za-z]:\\Users\\)[^\\\s]+/g, '$1<redacted>')
    .replace(/:\/\/[^/@\s]+:[^/@\s]+@/g, '://<redacted>@')
    .replace(/\bhf_[A-Za-z0-9]+/g, '<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>')
    .replace(
      new RegExp(`([?&](?:${SENSITIVE_QUERY_KEYS})=)[^&#\\s"']+`, 'gi'),
      '$1<redacted>'
    )
}

/** Last ~2KB of an error's details, PII-scrubbed, for `model_load.stderr_tail`. */
export function sanitizeStderrTail(details?: string | null): string | undefined {
  if (!details) return undefined
  const tail =
    details.length > STDERR_TAIL_BYTES
      ? details.slice(details.length - STDERR_TAIL_BYTES)
      : details
  return scrubPii(tail)
}

/** Host-only extraction (no path/query/token) for `resolved_asset_url_host`. */
export function urlHost(url?: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null
  }
}

export function isHfUrl(url?: string | null): boolean {
  const host = urlHost(url)
  return (
    !!host &&
    (host === 'huggingface.co' ||
      host === 'hf.co' ||
      host.endsWith('.huggingface.co') ||
      host.endsWith('.hf.co'))
  )
}

export function mapGpuVendor(raw?: string | null, isMac?: boolean): GpuVendor {
  if (raw) {
    const v = raw.toLowerCase()
    if (v.includes('nvidia')) return 'nvidia'
    if (v.includes('amd') || v.includes('advanced micro')) return 'amd'
    if (v.includes('intel')) return 'intel'
    if (v.includes('apple')) return 'apple'
  }
  if (isMac) return 'apple'
  return 'none'
}

export function cpuAvxLevel(extensions?: string[] | null): CpuAvxLevel {
  if (!extensions || extensions.length === 0) return 'none'
  const set = new Set(extensions.map((e) => e.toLowerCase()))
  if ([...set].some((e) => e.startsWith('avx512'))) return 'avx512'
  if (set.has('avx2')) return 'avx2'
  if (set.has('avx')) return 'avx'
  return 'none'
}

export function loadBackendFromProvider(provider?: string | null): LoadBackend {
  if (
    provider === 'llamacpp' ||
    provider === 'llamacpp-upstream' ||
    provider === 'mlx' ||
    provider === 'foundation-models'
  )
    return provider
  return 'unknown'
}

const downloadStartTimes = new Map<string, number>()
const finalizedDownloads = new Set<string>()

/** Record the start time of a download so terminal events can report duration. */
export function markDownloadStart(id: string): void {
  downloadStartTimes.set(id, Date.now())
  finalizedDownloads.delete(id)
}

/** Return elapsed ms since the matching `markDownloadStart`, or null. */
export function takeDownloadDuration(id: string): number | null {
  const start = downloadStartTimes.get(id)
  if (start == null) return null
  downloadStartTimes.delete(id)
  return Date.now() - start
}

/**
 * Guard so a single download emits exactly one terminal `model_download` event,
 * even when both `onFileDownloadSuccess` and
 * `onFileDownloadAndVerificationSuccess` fire. Returns true only the first time.
 */
export function finalizeDownloadOnce(id: string): boolean {
  if (finalizedDownloads.has(id)) return false
  finalizedDownloads.add(id)
  if (finalizedDownloads.size > 500) finalizedDownloads.clear()
  return true
}

const downloadedModelKeys = new Set<string>()

function normalizeModelKey(modelId?: string | null): string {
  if (!modelId) return ''
  const tail = modelId.split(/[\\/]/).pop() ?? modelId
  return tail.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Mark a model as freshly downloaded this session (call on download success). */
export function markModelDownloaded(modelId?: string | null): void {
  const key = normalizeModelKey(modelId)
  if (!key) return
  downloadedModelKeys.add(key)
  if (downloadedModelKeys.size > 500) downloadedModelKeys.clear()
}

export function modelLoadSource(modelId?: string | null): 'download' | 'local_disk' {
  return downloadedModelKeys.has(normalizeModelKey(modelId))
    ? 'download'
    : 'local_disk'
}

const modelLoadFailureThrottle = new Map<string, number>()
const MODEL_LOAD_FAILURE_THROTTLE_MS = 5 * 60_000

/**
 * ATO-133: throttle repeated identical `model_load` failures. A device stuck in
 * a load crashloop (model that keeps failing to load) otherwise emits thousands
 * of identical events, skewing event-weighted metrics. Returns true if this
 * (model, error_code) failure should be emitted, false if an identical one was
 * already emitted within the throttle window. Successes are never throttled.
 */
export function shouldEmitModelLoadFailure(
  modelId: string,
  errorCode: string | null
): boolean {
  const key = `${modelId}::${errorCode ?? 'unknown'}`
  const now = Date.now()
  const last = modelLoadFailureThrottle.get(key)
  if (last !== undefined && now - last < MODEL_LOAD_FAILURE_THROTTLE_MS) {
    return false
  }
  modelLoadFailureThrottle.set(key, now)
  if (modelLoadFailureThrottle.size > 500) modelLoadFailureThrottle.clear()
  return true
}

const modelLoadSentryThrottle = new Map<string, number>()

/**
 * WS1.5 (Sentry desktop top-10): throttle repeated model-load Sentry captures
 * using the same (model, error_code) key and 5-min window as
 * `shouldEmitModelLoadFailure`, but on an independent map so the PostHog and
 * Sentry gates do not suppress each other. Returns true if this failure should
 * be captured to Sentry, false if an identical one was captured within the
 * window — so a load crashloop cannot flood the crash channel.
 */
export function shouldCaptureModelLoadSentry(
  modelId: string,
  errorCode: string | null
): boolean {
  const key = `${modelId}::${errorCode ?? 'unknown'}`
  const now = Date.now()
  const last = modelLoadSentryThrottle.get(key)
  if (last !== undefined && now - last < MODEL_LOAD_FAILURE_THROTTLE_MS) {
    return false
  }
  modelLoadSentryThrottle.set(key, now)
  if (modelLoadSentryThrottle.size > 500) modelLoadSentryThrottle.clear()
  return true
}

/**
 * WS1.5: model-load error codes that represent recoverable / expected user or
 * config conditions (missing file, unsupported multimodal projector) rather than
 * a backend crash. These must NOT be sent to Sentry as crash events.
 */
const RECOVERABLE_MODEL_LOAD_CODES = new Set<string>([
  'MODEL_FILE_NOT_FOUND',
  // A partial / incomplete download (ATO-187) is a recoverable user condition
  // fixed by re-downloading — not a backend crash.
  'MODEL_FILE_CORRUPT',
  // A multi-part GGUF missing some of its shards. Fixed by re-downloading the
  // model, so it belongs with the incomplete-download conditions above.
  'MODEL_SHARDS_INCOMPLETE',
  'BINARY_NOT_FOUND',
  'MULTIMODAL_PROJECTOR_LOAD_FAILED',
  // A model whose architecture/format this engine build can't parse (e.g. a
  // newer qwen3vl GGUF). A deterministic incompatibility, not a backend crash.
  'MODEL_ARCH_NOT_SUPPORTED',
  // ATO-190: deterministic environment incompatibility (macOS too old for the
  // bundled Metal engine), not a code crash — don't flood the crash channel.
  'OS_VERSION_UNSUPPORTED',
  // ATO-185: the host CPU lacks the AVX baseline the bundled engine requires.
  // This is an expected hardware-incompatibility condition, not a backend
  // crash, so it must not be reported to Sentry as a crash event.
  'CPU_NO_AVX',
])

export function isRecoverableModelLoadCode(
  code: string | null | undefined
): boolean {
  return code != null && RECOVERABLE_MODEL_LOAD_CODES.has(code)
}

/* -------------------------------------------------------------------------
 * Chat-turn telemetry (ATO-2xx: `chat_response_received`).
 *
 * Same PII contract as the rest of this module. Text is only ever reported as
 * a coarse `*_bucket`; attachment *names* never leave the device (only an
 * allow-listed extension); tool names coming from user-configured MCP servers
 * are hashed, because a server name can itself describe the user's internal
 * systems.
 * ---------------------------------------------------------------------- */

export type LengthBucket =
  | 'unknown'
  | 'empty'
  | 'lt_100'
  | '100_500'
  | '500_2k'
  | '2k_10k'
  | 'gt_10k'

/** Coarse text-length bucket. Never report an exact character count. */
export function lengthBucket(chars?: number | null): LengthBucket {
  if (chars == null || chars < 0) return 'unknown'
  if (chars === 0) return 'empty'
  if (chars < 100) return 'lt_100'
  if (chars < 500) return '100_500'
  if (chars < 2000) return '500_2k'
  if (chars < 10000) return '2k_10k'
  return 'gt_10k'
}

export type CtxUsedBucket =
  | 'unknown'
  | 'lt_25'
  | '25_50'
  | '50_75'
  | '75_90'
  | '90_100'
  | 'gt_100'

/** How full the context window was, as a bucket over percent-used. */
export function ctxUsedBucket(pct?: number | null): CtxUsedBucket {
  if (pct == null || Number.isNaN(pct) || pct < 0) return 'unknown'
  if (pct < 25) return 'lt_25'
  if (pct < 50) return '25_50'
  if (pct < 75) return '50_75'
  if (pct < 90) return '75_90'
  if (pct <= 100) return '90_100'
  return 'gt_100'
}

/** Percent-used from a token count + context length, or null if unknowable. */
export function ctxUsedPercent(
  tokens?: number | null,
  ctxLen?: number | null
): number | null {
  if (tokens == null || ctxLen == null || ctxLen <= 0) return null
  return (tokens / ctxLen) * 100
}

/**
 * The file extension of an attachment, but only when it is one this app
 * actually accepts. Anything else collapses to `'other'` so an unusual
 * extension can never carry part of a filename off the device. The name
 * itself is never returned.
 */
export function attachmentExt(nameOrPath?: string | null): string {
  if (!nameOrPath) return 'other'
  const base = nameOrPath.split(/[\\/]/).pop() ?? ''
  if (!base.includes('.')) return 'other'
  const ext = (base.split('.').pop() || '').toLowerCase()
  if (
    IMAGE_EXTENSIONS.has(ext) ||
    AUDIO_EXTENSIONS.has(ext) ||
    DOCUMENT_EXTENSIONS.has(ext)
  )
    return ext
  return 'other'
}

/** FNV-1a. Synchronous by necessity — `crypto.subtle` is async and these run
 * inside `posthog.capture` argument construction. Not a security primitive;
 * it only needs to be stable and non-reversible enough to group by. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Sanitize a tool name for analytics. Tools we ship (RAG retrieval, stock
 * skills) are reported verbatim so feature usage is legible; anything from a
 * user-configured MCP server becomes `mcp_<hash8>` — stable across sessions
 * and devices, so cohorts still work, but not readable.
 */
export function toolNameForAnalytics(
  name: string,
  builtinNames?: ReadonlySet<string> | null
): string {
  if (!name) return 'unknown'
  if (builtinNames?.has(name)) return name
  return `mcp_${fnv1a(name)}`
}

export type ChatFailureKind =
  | 'aborted'
  | 'context_overflow'
  | 'oom'
  | 'model_access'
  | 'model_unreachable'
  | 'model_load_failed'
  | 'auth'
  | 'rate_limit'
  | 'content_filter'
  | 'bad_request'
  | 'server_error'
  | 'network'
  | 'timeout'
  | 'unknown'

/** Normalize the many error shapes the AI SDK / transport can surface. */
function errorText(error: unknown): string {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && 'message' in error)
    return String((error as { message?: unknown }).message ?? '')
  return ''
}

/**
 * Best-effort HTTP status out of a stringly-typed chat error. Broader than
 * `parseHttpStatus` (which only knows the download layer's `HTTP status NNN`
 * wording) because provider SDKs phrase it a dozen different ways.
 */
export function chatHttpStatus(error: unknown): number | null {
  const raw = errorText(error)
  if (!raw) return null
  const viaDownloadFormat = parseHttpStatus(raw)
  if (viaDownloadFormat != null) return viaDownloadFormat
  const match = raw.match(
    /\b(?:status(?:\s*code)?|http|code)\b\D{0,10}?([1-5]\d{2})\b/i
  )
  return match ? parseInt(match[1], 10) : null
}

/**
 * Classify a failed chat turn into a stable enum. Reuses the matchers the UI
 * already trusts (`utils/error.ts`, which mirror the Rust proxy's matchers) so
 * telemetry and the error banner can never disagree about what went wrong.
 * `rate_limit` and `content_filter` have no client-side handling today — they
 * are classified here so the gap becomes measurable.
 */
export function classifyChatFailure(error: unknown): ChatFailureKind {
  const raw = errorText(error)
  if (!raw) return 'unknown'
  const e = raw.toLowerCase()

  if (/\b(abort|aborted|cancel|cancelled|canceled|user stopped)\b/.test(e))
    return 'aborted'
  if (
    e.includes('content filter') ||
    e.includes('content_filter') ||
    e.includes('content policy') ||
    e.includes('safety filter')
  )
    return 'content_filter'
  if (isContextLimitError(raw)) return 'context_overflow'
  if (isOutOfMemoryError(raw)) return 'oom'
  if (isModelAccessError(raw)) return 'model_access'

  const status = chatHttpStatus(raw)
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'

  if (
    e.includes('econnrefused') ||
    e.includes('connection refused') ||
    e.includes('failed to fetch') ||
    e.includes('load failed') ||
    status === 502 ||
    status === 503
  )
    return 'model_unreachable'
  if (
    e.includes('failed to load model') ||
    e.includes('model_load') ||
    e.includes('no model loaded')
  )
    return 'model_load_failed'
  if (e.includes('timed out') || e.includes('timeout')) return 'timeout'
  if (status != null && status >= 500) return 'server_error'
  if (status != null && status >= 400) return 'bad_request'
  if (
    e.includes('network') ||
    e.includes('connection') ||
    e.includes('dns') ||
    e.includes('socket')
  )
    return 'network'
  return 'unknown'
}

const finalizedChatTurns = new Set<string>()

/**
 * Guard so a chat turn emits exactly one `chat_response_received`. `onFinish`
 * fires more than once per message (see the dedup comment in the thread
 * route), and the error path can race the finish path. Returns true only the
 * first time for a given turn id.
 */
export function finalizeChatTurnOnce(turnId: string): boolean {
  if (!turnId) return false
  if (finalizedChatTurns.has(turnId)) return false
  finalizedChatTurns.add(turnId)
  if (finalizedChatTurns.size > 500) finalizedChatTurns.clear()
  return true
}

const chatFailureThrottle = new Map<string, number>()

/**
 * Same rationale as `shouldEmitModelLoadFailure`: a backend stuck failing
 * every request would otherwise emit one event per retry and dominate
 * event-weighted metrics. Successes are never throttled — only call this on
 * failure paths.
 */
export function shouldEmitChatFailure(
  modelId: string | null | undefined,
  errorKind: ChatFailureKind
): boolean {
  const key = `${modelId ?? 'unknown'}::${errorKind}`
  const now = Date.now()
  const last = chatFailureThrottle.get(key)
  if (last !== undefined && now - last < MODEL_LOAD_FAILURE_THROTTLE_MS)
    return false
  chatFailureThrottle.set(key, now)
  if (chatFailureThrottle.size > 500) chatFailureThrottle.clear()
  return true
}
