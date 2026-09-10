/**
 * ATO-113: Sentry frontend integration for Atomic Chat.
 *
 * - Initialised once, early in `main.tsx`, before the router so the React
 *   `ErrorBoundary` and the global `window.onerror` / `unhandledrejection`
 *   handlers (default integrations) catch everything.
 * - Sending is gated behind the existing `productAnalytic` consent: we do NOT
 *   re-init on toggle; `beforeSend` / `beforeBreadcrumb` consult the consent
 *   store and return `null` when it is off. This keeps "100% capture when
 *   consented" without re-init churn.
 * - Zero-PII: `sendDefaultPii: false`, anonymous device id only, and every
 *   outgoing event/breadcrumb is run through the shared `scrubPii` doctrine
 *   plus key-based redaction (tokens/creds/base_url) and request-body dropping.
 */
import * as Sentry from '@sentry/react'

import { useProductAnalytic } from '@/hooks/useAnalytic'
import { scrubPii } from '@/lib/telemetry'

let initialized = false

function consentEnabled(): boolean {
  try {
    return useProductAnalytic.getState().productAnalytic
  } catch {
    // Store not ready yet — fail closed (no send) until consent is known.
    return false
  }
}

/** Object keys whose values are dropped wholesale (creds / endpoints / PII). */
const SENSITIVE_KEY_RE =
  /^(authorization|cookie|set-cookie|x-api-key|api[_-]?key|token|access_token|refresh_token|auth|secret|password|passwd|base_url|hf_token|huggingface_token|proxy|email|username|user_name|ip|ip_address|serial|uuid|hostname|host_name|machine|machine_name)$/i

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubPii(value)
  if (Array.isArray(value)) return value.map(scrubValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? '<redacted>' : scrubValue(val)
    }
    return out
  }
  return value
}

function scrubRecord(
  record: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!record) return record
  return scrubValue(record) as Record<string, unknown>
}

/**
 * Sources that only exist while Vite serves the app: the HMR client and the
 * React Refresh runtime. A packaged build contains neither, so matching on
 * them cannot suppress a production exception.
 */
const DEV_ONLY_SOURCE_RE = /@react-refresh|@vite\/client|__vite_ping|\/@fs\//

/** Messages raised by the dev-server module graph itself. */
const DEV_ONLY_MESSAGE_RE = /RefreshRuntime|\[hmr\]|\[vite\]/i

/**
 * Whether an event was produced by the development toolchain swapping modules
 * under a live component tree. These are a developer-session artefact and
 * carry no signal about the shipped app.
 */
export function isDevelopmentOnlyEvent(event: Sentry.ErrorEvent): boolean {
  const messages: string[] = []
  if (typeof event.message === 'string') messages.push(event.message)

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) messages.push(exception.value)
    for (const frame of exception.stacktrace?.frames ?? []) {
      const source = frame.abs_path ?? frame.filename ?? ''
      if (DEV_ONLY_SOURCE_RE.test(source)) return true
    }
  }

  return messages.some((message) => DEV_ONLY_MESSAGE_RE.test(message))
}

/**
 * Tauri raises this from `_unlisten` when a listener registered by an async
 * effect is detached twice. It surfaces from every hook that listens, so the
 * default grouping (by stack) scatters one defect across several issues.
 *
 * Call sites detach through `createSafeUnlisten` or the events service that
 * wraps it, but the helper only reached them gradually and shipped builds still
 * carry the raw pattern, so this keeps firing from the field. The fingerprint
 * groups every such report — old builds, and any listener added without the
 * helper — into a single issue.
 */
/**
 * A download the user cancelled. The backend reports the abort by rejecting the
 * download promise with this string, which reached the global
 * unhandled-rejection handler and was filed as a crash affecting dozens of
 * users per week. Pressing cancel is the feature working.
 */
const USER_CANCELLED_RE = /\bDownload cancelled\b/

function isUserCancellation(event: Sentry.ErrorEvent): boolean {
  const raised = [
    typeof event.message === 'string' ? event.message : '',
    ...(event.exception?.values ?? []).map((e) => e.value ?? ''),
  ]
  return raised.some((message) => USER_CANCELLED_RE.test(message))
}

const TAURI_UNLISTEN_RACE_RE = /listeners\[[^\]]+\]\.handlerId/

/**
 * Model-load and download failures are reported from a choke point that already
 * tags the classified cause, but the exception's own text is the engine's error
 * followed by a pasted llama.cpp log. Sentry groups on that text, so a single
 * condition (out of memory, disk full, an unreadable GGUF) fanned out into a
 * dozen issues that differed only in which model path and which log lines the
 * user happened to produce. Group by the cause the engine already named — the
 * same `["model-load-failure", CODE]` shape the Rust side applies to the
 * webview-bridged copy of these events (see `core/telemetry/mod.rs`).
 */
const LOAD_FAILURE_FEATURES: Record<string, string> = {
  model_load: 'model-load-failure',
  model_download: 'model-download-failure',
}

/**
 * Causes that live in the user's environment rather than in our code: not
 * enough memory or disk, a model this machine or build cannot run, a download
 * the network or the remote refused. They are worth counting — a spike still
 * means something changed — but they are not defects, so they are recorded at
 * `warning` instead of competing with crashes for attention.
 */
const ENVIRONMENT_FAILURE_CODES = new Set<string>([
  // Model load
  'OUT_OF_MEMORY',
  'MODEL_FILE_NOT_FOUND',
  'MODEL_FILE_CORRUPT',
  'MODEL_SHARDS_INCOMPLETE',
  'MODEL_ARCH_NOT_SUPPORTED',
  'MODEL_LOAD_TIMED_OUT',
  'MULTIMODAL_PROJECTOR_LOAD_FAILED',
  'BINARY_NOT_FOUND',
  'LIBRARY_PATH_INVALID',
  'OS_VERSION_UNSUPPORTED',
  'CPU_NO_AVX',
  'IO_ERROR',
  'INVALID_ARGUMENT',
])

/** The engine's headline is the first line; the rest is the pasted log. */
function headline(value: string): string {
  return value.split('\n', 1)[0].trim()
}

function loadFailureGrouping(event: Sentry.ErrorEvent): string[] | undefined {
  const feature = event.tags?.feature
  if (typeof feature !== 'string') return undefined
  const prefix = LOAD_FAILURE_FEATURES[feature]
  if (!prefix) return undefined

  const cause = event.tags?.error_code ?? event.tags?.failure_reason
  return [prefix, typeof cause === 'string' && cause ? cause : 'UNCLASSIFIED']
}

export function applyKnownFingerprints(
  event: Sentry.ErrorEvent
): Sentry.ErrorEvent {
  const raised = [
    typeof event.message === 'string' ? event.message : '',
    ...(event.exception?.values ?? []).map((e) => e.value ?? ''),
  ]
  if (raised.some((message) => TAURI_UNLISTEN_RACE_RE.test(message))) {
    event.fingerprint = ['tauri-unlisten-race']
    return event
  }

  const grouping = loadFailureGrouping(event)
  if (grouping) {
    event.fingerprint = grouping
    if (ENVIRONMENT_FAILURE_CODES.has(grouping[1])) {
      event.level = 'warning'
    }
    // The engine log rides along in `extra.stderr_tail` already; keeping a copy
    // in the exception value only made every issue title a wall of log lines.
    for (const value of event.exception?.values ?? []) {
      if (value.value) value.value = headline(value.value)
    }
  }
  return event
}

/** Run an event through the zero-PII doctrine in-place and return it. */
function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  // Never ship machine name; keep only the anonymous device id on user.
  event.server_name = undefined
  if (event.user) {
    event.user = { id: event.user.id }
  }

  if (typeof event.message === 'string') {
    event.message = scrubPii(event.message)
  }

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubPii(exception.value)
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = scrubPii(frame.filename)
      if (frame.abs_path) frame.abs_path = scrubPii(frame.abs_path)
      // Local variables can capture prompt text / paths / tokens verbatim.
      frame.vars = undefined
    }
  }

  event.extra = scrubRecord(event.extra)

  if (event.request) {
    // The request body carries prompts; drop it. Keep a scrubbed URL shape.
    event.request.data = undefined
    event.request.cookies = undefined
    if (event.request.url) event.request.url = scrubPii(event.request.url)
    event.request.query_string = undefined
    event.request.headers = scrubRecord(
      event.request.headers as Record<string, unknown> | undefined
    ) as typeof event.request.headers
  }

  return event
}

function scrubBreadcrumb(crumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  // Drop the noisiest free-text / network-body sources entirely.
  if (crumb.category === 'ui.input' || crumb.category === 'console') {
    return null
  }
  if (typeof crumb.message === 'string') {
    crumb.message = scrubPii(crumb.message)
  }
  if (crumb.data) {
    // fetch/xhr breadcrumbs may carry bodies; keep only structural fields.
    const data = scrubRecord(crumb.data) ?? {}
    delete data.body
    delete data.request_body
    delete data.response_body
    crumb.data = data
  }
  return crumb
}

export function initSentryFrontend(): void {
  if (initialized) return
  if (typeof SENTRY_DSN === 'undefined' || !SENTRY_DSN) return
  if (typeof IS_TAURI === 'undefined' || !IS_TAURI) return
  // A local `.env` carrying a real DSN plus SENTRY_ENVIRONMENT=development
  // made `tauri dev` report into the production project — a third of the
  // frontend project's volume. Developer machines have the terminal and the
  // devtools console; they do not need to page the crash dashboard.
  if (
    typeof SENTRY_ENVIRONMENT !== 'undefined' &&
    SENTRY_ENVIRONMENT === 'development'
  )
    return

  Sentry.init({
    dsn: SENTRY_DSN,
    release: typeof SENTRY_RELEASE !== 'undefined' ? SENTRY_RELEASE : undefined,
    environment:
      typeof SENTRY_ENVIRONMENT !== 'undefined' ? SENTRY_ENVIRONMENT : undefined,
    // Zero-PII + no perf/replay for now (ATO-113 scope).
    sendDefaultPii: false,
    tracesSampleRate: 0,
    // Keep DEFAULT integrations (so window.onerror / unhandledrejection are
    // auto-captured) but add no tracing/replay integration.
    beforeSend(event) {
      if (!consentEnabled()) return null
      if (isDevelopmentOnlyEvent(event)) return null
      if (isUserCancellation(event)) return null
      return applyKnownFingerprints(scrubEvent(event))
    },
    beforeBreadcrumb(crumb) {
      if (!consentEnabled()) return null
      return scrubBreadcrumb(crumb)
    },
  })

  initialized = true
}

/** Anonymous device id only ($is_identified:false equivalent). */
export function setSentryUser(deviceId: string | null | undefined): void {
  if (!initialized || !deviceId) return
  Sentry.setUser({ id: deviceId })
}

/** Set zero-PII hardware/backend context tags (string values only). */
export function setSentryTags(tags: Record<string, string>): void {
  if (!initialized) return
  Sentry.setTags(tags)
}

/**
 * Reflect a consent toggle into both SDKs. The frontend client is gated in
 * `beforeSend`; this also pushes the flag to the Rust telemetry gate.
 */
export function setSentryConsent(enabled: boolean): void {
  if (typeof IS_TAURI !== 'undefined' && IS_TAURI) {
    import('@tauri-apps/api/core')
      .then(({ invoke }) =>
        invoke('set_telemetry_consent', { enabled })
      )
      .catch(() => {
        // Rust telemetry may be unavailable (e.g. no DSN baked in) — ignore.
      })
  }
}

/**
 * Give the Rust Sentry scope the same anonymous device id as the webview, so
 * a native crash is attributed to a user instead of reporting "0 users
 * impacted" on every desktop issue.
 */
export function setRustSentryUser(id: string | null | undefined): void {
  if (!id) return
  if (typeof IS_TAURI !== 'undefined' && IS_TAURI) {
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('set_telemetry_user', { id }))
      .catch(() => {
        // best-effort
      })
  }
}

/** Push the same zero-PII tags to the Rust Sentry scope for crash parity. */
export function setRustSentryContext(tags: Record<string, string>): void {
  if (typeof IS_TAURI !== 'undefined' && IS_TAURI) {
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('set_telemetry_context', { tags }))
      .catch(() => {
        // best-effort
      })
  }
}

type CaptureTags = Record<string, string | number | boolean | undefined | null>
type CaptureExtra = Record<string, unknown>

function dropEmpty(tags: CaptureTags): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined || value === null || value === '') continue
    out[key] = String(value)
  }
  return out
}

/**
 * Explicit capture for a user-facing error choke point. Tags are coerced to
 * strings and empties dropped; `extra` is passed through the same scrubber as
 * automatic events (via `beforeSend`).
 */
export function captureHandledError(
  error: unknown,
  level: Sentry.SeverityLevel,
  tags: CaptureTags,
  extra?: CaptureExtra
): void {
  if (!initialized) return
  Sentry.withScope((scope) => {
    scope.setLevel(level)
    scope.setTags(dropEmpty(tags))
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        scope.setExtra(key, value)
      }
    }
    if (error instanceof Error) {
      Sentry.captureException(error)
    } else {
      Sentry.captureMessage(
        typeof error === 'string' ? error : JSON.stringify(error),
        level
      )
    }
  })
}
