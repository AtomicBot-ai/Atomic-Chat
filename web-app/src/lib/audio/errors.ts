/**
 * What to tell the user for each audio error code, and how to read a rejection
 * from the core.
 *
 * Exhaustive over `AudioErrorCode`: adding a code without a row here is a type
 * error, so no code reaches the banner as a bare SCREAMING_SNAKE string. The
 * words live under `audios:errors.<CODE>`; this module carries the routing.
 */

import {
  AUDIO_ERROR_CODES,
  type AudioErrorBody,
  type AudioErrorCode,
} from '@/services/audio/types'

/** The one thing the banner can offer to do about the error. */
export type AudioErrorAction = 'install' | 'chooseModel' | 'retry'

const ROUTES: Record<AudioErrorCode, AudioErrorAction | null> = {
  ENGINE_MISSING: 'install',
  ENGINE_INSTALL_FAILED: 'install',
  ENGINE_CRASHED: 'retry',
  MODEL_MISSING: 'chooseModel',
  MODEL_LOAD_FAILED: 'retry',
  MODEL_INCOMPATIBLE: 'chooseModel',
  MODEL_NOT_LOADED: 'retry',
  OUT_OF_MEMORY: 'chooseModel',
  UNSUPPORTED_BACKEND: null,
  // Another client swapped the model: Generate loads the form's model again.
  UNSUPPORTED_MODE: 'retry',
  INVALID_REQUEST: null,
  REQUEST_REJECTED: null,
  INVALID_OUTPUT: 'retry',
  JOB_BUSY: 'retry',
  JOB_NOT_FOUND: null,
  CANCELLED: null,
  DISK_FULL: null,
  BACKEND_IN_USE: null,
  INTERNAL: 'retry',
}

/**
 * The engine's own words are the only clue to what it refused; every other
 * code's details stay in the logs.
 */
const SHOWS_DETAILS: ReadonlySet<AudioErrorCode> = new Set(['REQUEST_REJECTED'])

export type AudioErrorDescription = {
  titleKey: string
  bodyKey: string
  action: AudioErrorAction | null
  showsDetails: boolean
}

export function describeAudioError(
  code: AudioErrorCode
): AudioErrorDescription {
  return {
    titleKey: `audios:errors.${code}.title`,
    bodyKey: `audios:errors.${code}.body`,
    action: ROUTES[code],
    showsDetails: SHOWS_DETAILS.has(code),
  }
}

const isAudioCode = (code: unknown): code is AudioErrorCode =>
  (AUDIO_ERROR_CODES as readonly unknown[]).includes(code)

/**
 * Narrow a rejection to the `{code, message, details}` the banner routes on.
 * The relay and the core's HTTP layer reject with codes of their own
 * (`CORE_UNREACHABLE`, `INVALID_ARGUMENT`, `HTTP_502`, ...): those read as
 * `INTERNAL`, the message kept and the code moved into the details.
 */
export function toAudioError(error: unknown): AudioErrorBody {
  if (!error || typeof error !== 'object') {
    return { code: 'INTERNAL', message: String(error ?? '') }
  }
  const { code, message, details } = error as Record<string, unknown>
  const text = typeof message === 'string' ? message : ''
  const more = typeof details === 'string' ? details : undefined
  if (isAudioCode(code)) {
    return more === undefined
      ? { code, message: text }
      : { code, message: text, details: more }
  }
  const carried =
    typeof code === 'string' && code !== ''
      ? more
        ? `${code}: ${more}`
        : code
      : more
  return carried === undefined
    ? { code: 'INTERNAL', message: text }
    : { code: 'INTERNAL', message: text, details: carried }
}

/** How the core words a route it does not have (`server/control/server.ts`). */
const MISSING_ROUTE = /no such control route/i

/**
 * Whether this core has no such route: a core older than the audio module
 * answers 404 on `/audio/*`. The relay keeps the core's envelope, whose code is
 * the generic `INVALID_ARGUMENT`, so the words tell it from a refused request;
 * a body that is not the envelope arrives as `HTTP_404` or `HTTP_405`.
 */
export function isMissingAudioRoute(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const { code, message } = error as Record<string, unknown>
  return (
    code === 'HTTP_404' ||
    code === 'HTTP_405' ||
    (typeof message === 'string' && MISSING_ROUTE.test(message))
  )
}
