import {
  AUTHENTICATION_FAILED_MESSAGE,
  AUTHENTICATION_FAILED_TITLE,
  CONTEXT_OVERFLOW_MESSAGE,
  CONTEXT_OVERFLOW_TITLE,
  MODEL_ACCESS_DENIED_MESSAGE,
  MODEL_ACCESS_DENIED_TITLE,
  OUT_OF_MEMORY_MESSAGE,
  OUT_OF_MEMORY_TITLE,
  isAuthenticationError,
  isContextLimitError,
  isModelAccessError,
  isOutOfMemoryError,
} from '@/utils/error'
import {
  contextOverflowGuidance,
  contextOverflowMessage,
} from '@/lib/managed-engine/chat'
import {
  RECOVERABLE_LOCAL_PROVIDERS,
  isEngineGoneError,
} from '@/lib/turn-recovery'

/**
 * What the chat's error card says about a failed turn: a readable cause, what
 * to do about it, and the raw diagnostic behind a collapsed Details region
 * whenever a readable sentence stands in for it (design review D7).
 */

export type TurnErrorKind =
  /** A managed engine's own overflow: its limit and where to raise it. */
  | 'managed-context'
  | 'context'
  | 'access'
  | 'auth'
  | 'oom'
  | 'engine-gone'
  /** The engine went away because a settings change restarted the model. */
  | 'settings-restart'
  | 'generic'

export type TurnErrorAction =
  | { type: 'open-engine-settings'; engineId: string; engineLabel: string }
  | { type: 'shorten-history' }
  | { type: 'increase-context' }
  | { type: 'retry' }

export type TurnErrorSummary = {
  kind: TurnErrorKind
  title: string
  body: string
  /** The raw diagnostic, shown collapsed; never the same text as the body. */
  details?: string
  action: TurnErrorAction
}

export type TurnErrorTranslate = (
  key: string,
  options?: Record<string, unknown>
) => string

export type TurnErrorContext = {
  /** The provider the failed turn ran on. */
  providerId: string | undefined
  t: TurnErrorTranslate
  /** The context cannot grow for the failed turn: offer to shorten history. */
  contextGrowthBlocked?: boolean
  /** The automatic restart of a gone engine did not bring it back. */
  engineRecoveryFailed?: boolean
  /**
   * The model's display name when a settings change restarted it under the
   * turn (`blameSettingsRestart`); a gone engine then says so.
   */
  settingsRestartModel?: string
}

/** A short message on one or two lines reads as a sentence; longer text is a diagnostic. */
const READABLE_MAX_LENGTH = 300
/** A message that carries links (a provider's policy banner) may run longer. */
const READABLE_WITH_LINKS_MAX_LENGTH = 800
const READABLE_MAX_LINES = 2

const LINK = /https?:\/\/\S+/
const TRANSPORT_TAG = /\[transport:[a-z_]+\]/
/** A JSON document, not a leading Markdown link `[label](url)`. */
const JSON_DOCUMENT = /^(?:\{|\[\s*[{["\d-]|\[\s*\])/
/** An envelope inside the text, e.g. `HTTP 500: {"error":{...}}`. */
const JSON_ENVELOPE = /\{\s*"[^"\n]+"\s*:/
const STACK_TRACE =
  /(?:^|\n)\s+at\s+\S|Traceback \(most recent call last\)|panicked at /

/**
 * Whether a provider's message is a diagnostic rather than a sentence for
 * the user: a transport tag with raw OS text, a JSON payload, a stack trace,
 * many lines, or very long text.
 */
export function isDiagnosticText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (TRANSPORT_TAG.test(trimmed)) return true
  if (JSON_DOCUMENT.test(trimmed) || JSON_ENVELOPE.test(trimmed)) return true
  if (STACK_TRACE.test(trimmed)) return true
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length > READABLE_MAX_LINES) return true
  const maxLength = LINK.test(trimmed)
    ? READABLE_WITH_LINKS_MAX_LENGTH
    : READABLE_MAX_LENGTH
  return trimmed.length > maxLength
}

function rawMessageOf(error: unknown): string {
  if (!error) return ''
  if (typeof error === 'string') return error.trim()
  if (error instanceof Error) return error.message.trim()
  if (typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? '').trim()
  }
  return ''
}

/**
 * The failure's class before any settings-restart attribution, in the order
 * the card has always checked them: a context overflow first, then model
 * access, authentication, out of memory, and a local engine that went away.
 */
export function turnErrorKind(
  error: unknown,
  providerId: string | undefined
): Exclude<TurnErrorKind, 'settings-restart'> {
  if (isContextLimitError(error)) {
    return contextOverflowGuidance(providerId, error)
      ? 'managed-context'
      : 'context'
  }
  if (isModelAccessError(error)) return 'access'
  if (isAuthenticationError(error)) return 'auth'
  if (isOutOfMemoryError(error)) return 'oom'
  if (
    providerId !== undefined &&
    RECOVERABLE_LOCAL_PROVIDERS.has(providerId) &&
    isEngineGoneError(error)
  ) {
    return 'engine-gone'
  }
  return 'generic'
}

/**
 * Whether a settings restart can explain the failure: the local engine went
 * away, or a local engine failed with nothing more specific to say.
 */
export function canBlameSettingsRestart(
  error: unknown,
  providerId: string | undefined
): boolean {
  if (!providerId || !RECOVERABLE_LOCAL_PROVIDERS.has(providerId)) return false
  const kind = turnErrorKind(error, providerId)
  return kind === 'engine-gone' || kind === 'generic'
}

/** The raw text for Details, unless it is empty or the card already shows it. */
function detailsBeside(
  raw: string,
  title: string,
  body: string
): string | undefined {
  if (!raw || raw === title || body.includes(raw)) return undefined
  return raw
}

export function summarizeTurnError(
  error: unknown,
  context: TurnErrorContext
): TurnErrorSummary {
  const { providerId, t } = context
  const raw = rawMessageOf(error)
  const baseKind = turnErrorKind(error, providerId)
  const kind: TurnErrorKind =
    context.settingsRestartModel &&
    (baseKind === 'engine-gone' ||
      (baseKind === 'generic' &&
        providerId !== undefined &&
        RECOVERABLE_LOCAL_PROVIDERS.has(providerId)))
      ? 'settings-restart'
      : baseKind

  switch (kind) {
    case 'managed-context': {
      // The body quotes the engine's own message; there is nothing more to show.
      const guidance = contextOverflowGuidance(providerId, error)!
      return {
        kind,
        title: CONTEXT_OVERFLOW_TITLE,
        body: contextOverflowMessage(guidance),
        action: {
          type: 'open-engine-settings',
          engineId: guidance.engine.id,
          engineLabel: guidance.engine.label,
        },
      }
    }
    case 'context':
      return {
        kind,
        title: CONTEXT_OVERFLOW_TITLE,
        body: CONTEXT_OVERFLOW_MESSAGE,
        details: detailsBeside(
          raw,
          CONTEXT_OVERFLOW_TITLE,
          CONTEXT_OVERFLOW_MESSAGE
        ),
        // The window cannot grow any more: send less history instead. The
        // draft, the message and its attachments stay as they are.
        action: context.contextGrowthBlocked
          ? { type: 'shorten-history' }
          : { type: 'increase-context' },
      }
    case 'access':
      return {
        kind,
        title: MODEL_ACCESS_DENIED_TITLE,
        body: MODEL_ACCESS_DENIED_MESSAGE,
        details: detailsBeside(
          raw,
          MODEL_ACCESS_DENIED_TITLE,
          MODEL_ACCESS_DENIED_MESSAGE
        ),
        action: { type: 'retry' },
      }
    case 'auth':
      return {
        kind,
        title: AUTHENTICATION_FAILED_TITLE,
        body: AUTHENTICATION_FAILED_MESSAGE,
        details: detailsBeside(
          raw,
          AUTHENTICATION_FAILED_TITLE,
          AUTHENTICATION_FAILED_MESSAGE
        ),
        action: { type: 'retry' },
      }
    case 'oom':
      // ATO-197: a fatal Metal/compute failure (GPU OOM) surfaces as the
      // opaque "Compute error" / the proxy's `insufficient_memory` envelope.
      return {
        kind,
        title: OUT_OF_MEMORY_TITLE,
        body: OUT_OF_MEMORY_MESSAGE,
        details: detailsBeside(raw, OUT_OF_MEMORY_TITLE, OUT_OF_MEMORY_MESSAGE),
        action: { type: 'retry' },
      }
    case 'engine-gone':
    case 'settings-restart': {
      // The local engine went away under the turn: say so instead of the
      // (often localized) OS text, which stays under Details.
      const title =
        kind === 'settings-restart'
          ? t('chat:turnRecovery.settingsRestartTitle')
          : t('chat:turnRecovery.engineGoneTitle')
      const body = context.engineRecoveryFailed
        ? t('chat:turnRecovery.engineRestartFailed')
        : kind === 'settings-restart'
          ? t('chat:turnRecovery.settingsRestartMessage', {
              model: context.settingsRestartModel,
            })
          : t('chat:turnRecovery.engineGoneMessage')
      return {
        kind,
        title,
        body,
        details: detailsBeside(raw, title, body),
        action: { type: 'retry' },
      }
    }
    case 'generic': {
      // The provider's own words are often the only explanation (and may
      // carry links), so a readable one stays the body. A diagnostic goes
      // under Details, behind a sentence that says what to do.
      const title = t('chat:turnRecovery.genericTitle')
      if (raw && !isDiagnosticText(raw)) {
        return { kind, title, body: raw, action: { type: 'retry' } }
      }
      const body = t('chat:turnRecovery.genericMessage')
      return {
        kind,
        title,
        body,
        details: detailsBeside(raw, title, body),
        action: { type: 'retry' },
      }
    }
  }
}
