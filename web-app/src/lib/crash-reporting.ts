/**
 * Radium's own crash reporting: opt-in, off by default, inert without a DSN.
 *
 * - The DSN comes only from the build (`SENTRY_DSN`, an optional CI secret,
 *   baked in by `vite.config.ts`). No DSN is written in this repository; a
 *   build without one never initialises the SDK and sends nothing.
 * - Consent is a separate setting (`crash-reporting`), off for every new and
 *   existing user. The consent inherited from the upstream app (the old
 *   `productAnalytic` key) is discarded by `migrateLegacyConsent`, never read.
 * - Every event goes through `scrubEvent` in `beforeSend`: no user, no request
 *   bodies, no breadcrumbs that can carry text the user typed, no file paths
 *   with a username, no API keys or bearer tokens, no e-mail addresses.
 * - The SDK is initialised once at startup when a DSN exists; turning the
 *   setting on or off takes effect at once because `beforeSend` reads it.
 */
import * as Sentry from '@sentry/react'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export const CRASH_REPORTING_STORAGE_KEY = 'crash-reporting'

/** Keys the upstream app used for analytics/crash consent. Never honoured. */
export const LEGACY_CONSENT_KEYS = ['productAnalytic', 'productAnalyticPrompt']

type CrashReportingState = {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}

export const useCrashReporting = create<CrashReportingState>()(
  persist(
    (set) => ({
      enabled: false,
      setEnabled: (enabled) => set({ enabled }),
    }),
    {
      name: CRASH_REPORTING_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ enabled: s.enabled }),
      // A persisted state from before version 1 cannot have been the user's
      // choice in Radium; start from off.
      migrate: () => ({ enabled: false }),
    }
  )
)

/** Drop the consent inherited from upstream so it can never switch this on. */
export function migrateLegacyConsent(storage: Storage = localStorage): void {
  try {
    for (const key of LEGACY_CONSENT_KEYS) storage.removeItem(key)
  } catch {
    // Storage unavailable: nothing was inherited either.
  }
}

export function crashReportingEnabled(): boolean {
  try {
    return useCrashReporting.getState().enabled === true
  } catch {
    return false
  }
}

// ── Scrubbing ───────────────────────────────────────────────────────────────

const REDACTED = '<redacted>'

/** Values under these keys are dropped wholesale. */
const SENSITIVE_KEY =
  /^(authorization|cookie|set-cookie|x-api-key|api[_-]?key|apikey|token|access_token|refresh_token|id_token|auth|secret|client_secret|password|passwd|base_url|baseurl|url|hf_token|proxy|email|username|user_name|user|ip|ip_address|hostname|host_name|prompt|prompts|messages|message_content|content|text|input|output|completion|body|data|query|system|instructions)$/i

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  // Bearer / basic credentials.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ' + REDACTED],
  // Provider keys: OpenAI/Anthropic (sk-…), Hugging Face (hf_…), Google
  // (AIza…), GitHub (gh*_…), xAI (xai-…), Groq (gsk_…), generic long hex.
  [
    /\b(sk-[A-Za-z0-9_-]{8,}|hf_[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{16,}|gsk_[A-Za-z0-9]{16,})/g,
    REDACTED,
  ],
  [/\b[0-9a-f]{32,}\b/gi, REDACTED],
  // key=value / "key": "value" pairs for credential-looking keys.
  [
    /((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)(?!Bearer\b|Basic\b|<redacted>)[^\s"'&,}]+/gi,
    '$1' + REDACTED,
  ],
  // Credentials in URLs.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1'],
  // Home directories: keep the shape, drop the user name.
  [/(\/Users\/|\/home\/)[^/\s"']+/g, '$1~'],
  [/([A-Za-z]:\\+(?:Users|Documents and Settings)\\+)[^\\\s"']+/gi, '$1~'],
  // E-mail addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
]

export function scrubText(text: string): string {
  let out = text
  for (const [re, replacement] of TEXT_PATTERNS)
    out = out.replace(re, replacement)
  return out
}

function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED
  if (typeof value === 'string') return scrubText(value)
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : scrubValue(v, depth + 1)
    }
    return out
  }
  return value
}

/** Breadcrumb categories that cannot carry user text. Everything else is dropped. */
const SAFE_BREADCRUMB_CATEGORIES = new Set(['navigation', 'ui.click'])

export function scrubBreadcrumb(
  crumb: Sentry.Breadcrumb
): Sentry.Breadcrumb | null {
  if (!crumb.category || !SAFE_BREADCRUMB_CATEGORIES.has(crumb.category)) {
    return null
  }
  return {
    ...crumb,
    message: crumb.message ? scrubText(crumb.message) : crumb.message,
    data: crumb.data
      ? (scrubValue(crumb.data) as Record<string, unknown>)
      : undefined,
  }
}

export function scrubEvent<E extends Sentry.Event>(event: E): E {
  const e: E = { ...event }
  delete e.user
  delete e.server_name
  if (e.request) {
    e.request = {
      url: e.request.url ? scrubText(e.request.url.split('?')[0]) : undefined,
    }
  }
  if (e.message) e.message = scrubText(e.message)
  if (e.exception?.values) {
    e.exception = {
      ...e.exception,
      values: e.exception.values.map((ex) => ({
        ...ex,
        value: ex.value ? scrubText(ex.value) : ex.value,
        stacktrace: ex.stacktrace && {
          ...ex.stacktrace,
          frames: ex.stacktrace.frames?.map((f) => ({
            ...f,
            filename: f.filename ? scrubText(f.filename) : f.filename,
            abs_path: f.abs_path ? scrubText(f.abs_path) : f.abs_path,
            vars: undefined,
          })),
        },
      })),
    }
  }
  if (e.breadcrumbs) {
    e.breadcrumbs = e.breadcrumbs
      .map(scrubBreadcrumb)
      .filter((b): b is Sentry.Breadcrumb => b !== null)
  }
  if (e.extra) e.extra = scrubValue(e.extra) as typeof e.extra
  if (e.contexts) e.contexts = scrubValue(e.contexts) as typeof e.contexts
  if (e.tags) e.tags = scrubValue(e.tags) as typeof e.tags
  return e
}

// ── Initialisation ──────────────────────────────────────────────────────────

let initialised = false

/** The DSN baked in at build time, or '' when the build had none. */
export function buildDsn(): string {
  try {
    return typeof SENTRY_DSN === 'string' ? SENTRY_DSN.trim() : ''
  } catch {
    return ''
  }
}

/**
 * Arm the SDK when — and only when — the build carries a DSN. Returns whether
 * it did. Sending additionally requires the user's consent, checked per event.
 */
export function initCrashReporting(dsn: string = buildDsn()): boolean {
  migrateLegacyConsent()
  if (initialised || !dsn) return false
  Sentry.init({
    dsn,
    release:
      typeof SENTRY_RELEASE === 'string' && SENTRY_RELEASE
        ? SENTRY_RELEASE
        : undefined,
    environment: import.meta.env.DEV ? 'development' : 'production',
    sendDefaultPii: false,
    // Errors only: no performance tracing, no session replay, no user
    // feedback widget, no automatic session tracking.
    tracesSampleRate: 0,
    integrations: (defaults) =>
      defaults.filter(
        (i) => !['BrowserSession', 'Replay', 'Feedback'].includes(i.name)
      ),
    beforeBreadcrumb: (crumb) =>
      crashReportingEnabled() ? scrubBreadcrumb(crumb) : null,
    beforeSend: (event) => (crashReportingEnabled() ? scrubEvent(event) : null),
  })
  initialised = true
  return true
}

/** Report an error caught by a boundary. A no-op unless armed and consented. */
export function reportError(error: unknown): void {
  if (!initialised || !crashReportingEnabled()) return
  Sentry.captureException(error)
}
