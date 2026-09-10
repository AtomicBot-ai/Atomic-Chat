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
  // ATO-467: `disk_io` was the single largest failure cause (647 devices) and
  // covered at least five unrelated faults. The Rust downloader now names the
  // subcause; `disk_io` stays as the catch-all, so old clients and unmapped
  // errors keep landing where they always did.
  | 'disk_full'
  | 'disk_permission'
  | 'disk_file_locked'
  | 'disk_path_too_long'
  | 'disk_device_lost'
  | 'disk_io'
  | 'network'
  | 'cancelled'
  | 'path_guard'
  | 'unknown'

/**
 * Subcause tags emitted by `src-tauri/src/core/downloads/disk.rs`. Kept as an
 * explicit allowlist so a malformed or unknown tag degrades to the heuristics
 * below instead of inventing a new enum value in PostHog.
 */
const DISK_FAULT_TAGS = new Set<DownloadFailureReason>([
  'disk_full',
  'disk_permission',
  'disk_file_locked',
  'disk_path_too_long',
  'disk_device_lost',
  'disk_io',
])

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

/**
 * Read the `[disk_*]` subcause tag the Rust downloader prefixes onto every
 * filesystem error (see `downloads/disk.rs`). Returns null for untagged errors
 * — legacy clients, and every non-filesystem failure.
 */
function diskFaultTag(err: string): DownloadFailureReason | null {
  const match = err.match(/\[(disk_[a-z_]+)\]/)
  if (!match) return null
  const tag = match[1] as DownloadFailureReason
  return DISK_FAULT_TAGS.has(tag) ? tag : null
}

/** Classify a stringly-typed download error into a stable enum. */
export function classifyDownloadFailure(
  err?: string | null
): DownloadFailureReason {
  if (!err) return 'unknown'
  const e = err.toLowerCase()
  if (/\b(abort|aborted|cancel|cancelled|canceled|stopped|interrupt)\b/.test(e))
    return 'cancelled'

  // The downloader's own tag beats every heuristic below: it was derived from
  // the OS error code, not from guessing at the message text.
  const tagged = diskFaultTag(err)
  if (tagged) return tagged

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
  if (d.includes('metal') || d.includes('iogpu') || d.includes('mtl'))
    return 'metal'
  if (
    d.includes('host') ||
    d.includes('system memory') ||
    d.includes('requires more ram')
  )
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
export function sanitizeStderrTail(
  details?: string | null
): string | undefined {
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

/**
 * How a subscription sign-in ended, from the backend's message.
 *
 * The Rust side reports failures as bare strings (`Result<_, String>`), and a
 * user cancelling in the browser comes back through the same rejected promise
 * as a real failure — so without this, "changed their mind" and "the flow is
 * broken" were the same number. Ordered like `classifyDownloadFailure`: the
 * specific causes first, `unknown` only when nothing matched.
 *
 * Strings are matched against `src-tauri/src/core/auth/chatgpt.rs` and
 * `commands.rs`; a message that drifts degrades to `unknown` rather than
 * being mislabelled.
 */
export type SubscriptionFailureReason =
  | 'cancelled'
  | 'timeout'
  | 'port_busy'
  | 'browser_open_failed'
  | 'state_mismatch'
  | 'provider_rejected'
  | 'token_rejected'
  | 'reauthorization_required'
  | 'network'
  | 'unknown'

export function classifySubscriptionFailure(
  error: unknown
): SubscriptionFailureReason {
  const raw =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : ''
  const e = raw.toLowerCase()
  if (!e) return 'unknown'

  // The user closed the browser tab or hit Cancel — not a failure at all.
  if (e.includes('sign-in cancelled') || e.includes('callback channel closed'))
    return 'cancelled'
  if (e.includes('timed out waiting for the browser')) return 'timeout'
  // The callback port is fixed by the provider's redirect URI, so this is
  // usually the Codex CLI holding it mid-login.
  if (e.includes('cannot listen on')) return 'port_busy'
  if (e.includes('cannot open the browser')) return 'browser_open_failed'
  if (e.includes('state did not match')) return 'state_mismatch'
  if (e.includes('reauthorization required')) return 'reauthorization_required'
  if (e.includes('token request rejected')) return 'token_rejected'
  if (
    e.includes('token request failed') ||
    e.includes('cannot build http client') ||
    e.includes('cannot read token response')
  )
    return 'network'
  // The provider reported its own `{error}: {description}`, e.g. the user
  // declined the consent screen.
  if (
    e.includes('access_denied') ||
    e.includes('carried no authorization code') ||
    e.includes('sign-in returned no refresh token')
  )
    return 'provider_rejected'
  return 'unknown'
}

/**
 * The executing backend of the last successful load, per model.
 *
 * Cached so `chat_response_received` can name it without an IPC on the
 * response path. Session-scoped on purpose: a stale value from a previous run
 * would be exactly the kind of claim that made `active_backend` untrustworthy.
 */
const execBackendByModel = new Map<string, string>()

export function rememberExecBackend(
  modelId: string,
  backend: string | null
): void {
  const key = normalizeModelId(modelId)
  if (!key) return
  if (!backend) {
    execBackendByModel.delete(key)
    return
  }
  execBackendByModel.set(key, backend)
  if (execBackendByModel.size > 200) {
    const oldest = execBackendByModel.keys().next().value
    if (oldest !== undefined) execBackendByModel.delete(oldest)
  }
}

/**
 * What computed this response, or `null` when nothing local did.
 *
 * The null case is the point: `active_backend` was a device super-property, so
 * it rode along on responses from Pollinations (44 of 44) and OpenAI (31 of
 * 49) too. Before remote providers were filtered out "CPU" showed 44.1 tps and
 * beat CUDA — the comparison was inverted, not merely noisy.
 */
export function execBackendForModel(
  modelId?: string | null,
  provider?: string | null
): string | null {
  if (loadBackendFromProvider(provider) === 'unknown') return null
  const key = normalizeModelId(modelId)
  return key ? (execBackendByModel.get(key) ?? null) : null
}

/** Test seam — the cache is module state and outlives a single test. */
export function resetExecBackendsForTests(): void {
  execBackendByModel.clear()
}

/** What the plugin parsed out of the llama-server startup log. */
export type RuntimeDeviceSnapshot = {
  loaded_backends?: string[] | null
  primary_device?: string | null
  gpu_layers_offloaded?: number | null
  total_layers?: number | null
  cuda_runtime_missing?: boolean | null
  device_init_error?: string | null
}

/**
 * How much of the model actually reached the GPU.
 *
 * The question ATO-468 exists to answer — "what share of devices run on GPU
 * versus CPU" — could not be asked at all: `n_gpu_layers` reports the
 * requested value, which is the `100` "offload everything" sentinel on 98.3%
 * of events, and nothing recorded the outcome. A CUDA build that silently
 * degrades to CPU (missing cudart, parked dGPU, driver mismatch) was
 * indistinguishable from one that worked.
 */
export type GpuOffloadBucket = 'none' | 'partial' | 'full' | 'unknown'

export function gpuOffloadBucket(
  device?: RuntimeDeviceSnapshot | null
): GpuOffloadBucket {
  const offloaded = device?.gpu_layers_offloaded
  const total = device?.total_layers
  if (typeof offloaded !== 'number' || offloaded < 0) return 'unknown'
  if (offloaded === 0) return 'none'
  if (typeof total !== 'number' || total <= 0) return 'partial'
  return offloaded >= total ? 'full' : 'partial'
}

/**
 * The backend that actually computed, as opposed to the build the device
 * downloaded.
 *
 * `active_backend` was a device-level super-property read from localStorage,
 * so it was attached even to responses from Pollinations and OpenAI, where no
 * local backend is involved at all — before remote providers were filtered
 * out, "CPU" showed 44.1 tps and beat CUDA, i.e. the metric was inverted.
 */
export function execBackend(
  device?: RuntimeDeviceSnapshot | null
): string | null {
  const primary = device?.primary_device
  if (typeof primary === 'string' && primary) {
    // `CUDA0` / `Vulkan0` / `Metal` / `CPU` — drop the device index so the
    // values group.
    return primary.replace(/\d+$/, '').toLowerCase() || null
  }
  const loaded = device?.loaded_backends
  return Array.isArray(loaded) && loaded.length > 0
    ? loaded[0].toLowerCase()
    : null
}

/**
 * Analytics-safe form of a model id.
 *
 * Local model ids are minted by slicing a filesystem path, so every Windows
 * build older than 06eafa9f1 produced `unsloth\gemma-...` where every other
 * platform produced `unsloth/gemma-...`. PostHog treats those as two different
 * models: one real model's download success rate read 11.8% on one string and
 * 95.1% on the other. Ids still arrive in the old shape from machines that
 * imported before that fix, so normalize at the point of emission — every
 * `model_id` property in the app goes through here.
 */
export function normalizeModelId(id?: string | null): string | null {
  if (!id) return null
  return id.replace(/\\/g, '/')
}

/**
 * What a model-load failure actually was.
 *
 * `error_code` is null on 68% of failure events — most paths never reach the
 * extension's `codedLoadError`, and the watchdog timeout never had a code at
 * all — which made the event-level failure taxonomy unusable and forced every
 * analysis onto device-level counts. This derives a kind from the code when
 * there is one and from the message otherwise, so the taxonomy works without
 * waiting for every path to grow a code.
 *
 * Ordered: `oom` first, because a memory failure that also mentions a missing
 * file is still a memory failure.
 */
export type ModelLoadFailureKind =
  | 'oom'
  | 'binary_missing'
  | 'model_file_missing'
  | 'shards_incomplete'
  | 'arch_unsupported'
  | 'os_unsupported'
  | 'timeout'
  | 'device_init'
  | 'process_crash'
  | 'unknown'

const LOAD_FAILURE_BY_CODE: Record<string, ModelLoadFailureKind> = {
  OUT_OF_MEMORY: 'oom',
  BINARY_NOT_FOUND: 'binary_missing',
  MODEL_FILE_NOT_FOUND: 'model_file_missing',
  MODEL_FILE_CORRUPT: 'model_file_missing',
  MODEL_SHARDS_INCOMPLETE: 'shards_incomplete',
  MODEL_ARCH_NOT_SUPPORTED: 'arch_unsupported',
  OS_VERSION_UNSUPPORTED: 'os_unsupported',
  LOCAL_API_SERVER_START_TIMEOUT: 'timeout',
  OPERATION_TIMED_OUT: 'timeout',
  DEVICE_LIST_PARSE_FAILED: 'device_init',
  LLAMA_CPP_PROCESS_ERROR: 'process_crash',
}

export function classifyModelLoadFailure(
  errorCode: string | null | undefined,
  haystack: string | null | undefined,
  /** The caller's OOM verdict. Passed in rather than recomputed so `is_oom`
   *  and `load_failure_kind` can never disagree about the same failure. */
  isOom: boolean
): ModelLoadFailureKind {
  // Checked before the code map, because on macOS a Metal OOM arrives as
  // `LLAMA_CPP_PROCESS_ERROR` with the real cause only in the stderr tail —
  // 2251 events across 124 devices, against 16 that carried `OUT_OF_MEMORY`.
  if (isOom) return 'oom'

  const byCode = errorCode ? LOAD_FAILURE_BY_CODE[errorCode] : undefined
  if (byCode) return byCode

  const e = (haystack ?? '').toLowerCase()
  if (!e) return 'unknown'
  if (e.includes('unknown projector type') || e.includes('unknown model architecture'))
    return 'arch_unsupported'
  if (e.includes('no such file') || e.includes('not found')) {
    return e.includes('llama-server') || e.includes('binary')
      ? 'binary_missing'
      : 'model_file_missing'
  }
  if (e.includes('missing shard') || e.includes('incomplete')) return 'shards_incomplete'
  if (e.includes('timed out') || e.includes('timeout')) return 'timeout'
  if (
    e.includes('failed to initialize') ||
    e.includes('no device') ||
    e.includes('driver')
  )
    return 'device_init'
  if (e.includes('exited') || e.includes('signal') || e.includes('crash'))
    return 'process_crash'
  return 'unknown'
}

/**
 * Models known to have been downloaded on this device.
 *
 * Persisted, unlike the in-memory set this replaced: a model downloaded
 * yesterday and loaded today reported `local_disk`, so `model_source` only
 * ever said `download` for a download and a load inside the same app run.
 * That is also why `local_disk` could not be read as "the user imported this".
 */
const DOWNLOADED_MODELS_KEY = 'telemetry-downloaded-models'
const MAX_DOWNLOADED_KEYS = 500

function readDownloadedKeys(): string[] {
  try {
    const raw = localStorage.getItem(DOWNLOADED_MODELS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : []
  } catch {
    return []
  }
}

const downloadedModelKeys = new Set<string>()

function normalizeModelKey(modelId?: string | null): string {
  if (!modelId) return ''
  const tail = modelId.split(/[\\/]/).pop() ?? modelId
  return tail.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Mark a model as downloaded by this device (call on download success). */
export function markModelDownloaded(modelId?: string | null): void {
  const key = normalizeModelKey(modelId)
  if (!key) return
  const keys = readDownloadedKeys().filter((k) => k !== key)
  keys.push(key)
  // Oldest-first eviction rather than the wholesale `clear()` this used to do,
  // which made a device with many models forget everything at once.
  const trimmed = keys.slice(-MAX_DOWNLOADED_KEYS)
  downloadedModelKeys.clear()
  for (const k of trimmed) downloadedModelKeys.add(k)
  try {
    localStorage.setItem(DOWNLOADED_MODELS_KEY, JSON.stringify(trimmed))
  } catch {
    // localStorage unavailable — falls back to session-only behaviour.
  }
}

export function modelLoadSource(
  modelId?: string | null
): 'download' | 'local_disk' {
  const key = normalizeModelKey(modelId)
  if (!key) return 'local_disk'
  return downloadedModelKeys.has(key) || readDownloadedKeys().includes(key)
    ? 'download'
    : 'local_disk'
}

/** Test seam — drops the persisted download markers. */
export function resetDownloadedModelsForTests(): void {
  downloadedModelKeys.clear()
  try {
    localStorage.removeItem(DOWNLOADED_MODELS_KEY)
  } catch {
    // nothing to clear
  }
}

/**
 * Shared time-window throttle.
 *
 * Evicts oldest-first at the cap. The three throttles here used to `clear()`
 * on overflow, so a device with more distinct keys than the cap wiped its
 * whole window and started emitting freely again — exactly the devices whose
 * event volume the throttle exists to bound.
 */
const THROTTLE_MAX_KEYS = 500

function throttle(
  seen: Map<string, number>,
  key: string,
  windowMs: number
): boolean {
  const now = Date.now()
  const last = seen.get(key)
  if (last !== undefined && now - last < windowMs) return false
  seen.delete(key)
  seen.set(key, now)
  while (seen.size > THROTTLE_MAX_KEYS) {
    const oldest = seen.keys().next().value
    if (oldest === undefined) break
    seen.delete(oldest)
  }
  return true
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
  return throttle(
    modelLoadFailureThrottle,
    `${modelId}::${errorCode ?? 'unknown'}`,
    MODEL_LOAD_FAILURE_THROTTLE_MS
  )
}

const modelLoadSuccessThrottle = new Map<string, number>()
const MODEL_LOAD_SUCCESS_THROTTLE_MS = 60_000

/**
 * ATO-468: throttle repeated identical `model_load` successes.
 *
 * Only failures were throttled, so a stop/start oscillation that keeps
 * succeeding emitted without limit — one device produced 278,751 `model_load`
 * events in three months, 62.9% of every such event in the project. Any
 * event-weighted metric was therefore wrong by default.
 */
export function shouldEmitModelLoadSuccess(
  modelId: string,
  backend: string | null
): boolean {
  return throttle(
    modelLoadSuccessThrottle,
    `${modelId}::${backend ?? 'unknown'}`,
    MODEL_LOAD_SUCCESS_THROTTLE_MS
  )
}

/** Test seam — the throttles are module state and outlive a single test. */
export function resetModelLoadThrottlesForTests(): void {
  modelLoadFailureThrottle.clear()
  modelLoadSuccessThrottle.clear()
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
  return throttle(
    modelLoadSentryThrottle,
    `${modelId}::${errorCode ?? 'unknown'}`,
    MODEL_LOAD_FAILURE_THROTTLE_MS
  )
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
  return throttle(
    chatFailureThrottle,
    `${modelId ?? 'unknown'}::${errorKind}`,
    MODEL_LOAD_FAILURE_THROTTLE_MS
  )
}
