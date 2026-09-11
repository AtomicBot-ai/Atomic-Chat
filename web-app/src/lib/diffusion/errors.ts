/**
 * What to tell the user for each native diffusion error code.
 *
 * Exhaustive over `NativeDiffusionErrorCode`: adding a code to the contract
 * without a row here is a type error, so no code can reach the banner as a
 * bare SCREAMING_SNAKE string. Copy lives under `images:errors.<CODE>` so the
 * locale files carry the words and this module only carries the routing.
 */

import type { NativeDiffusionErrorCode } from '@/services/diffusion/types'

/** The one thing the banner can offer to do about the error. */
export type DiffusionErrorAction =
  /** Open the setup dialog on the engine step. */
  | 'install'
  /** Open the setup dialog on the model step. */
  | 'download'
  /** Go to Settings → Media. */
  | 'openSettings'
  /** Reveal the output folder so the user can free space. */
  | 'openOutputFolder'
  /** Drop the size to 768×768 and try again. */
  | 'reduceSize'
  /** Switch to a smaller quant of the same family. */
  | 'pickSmallerQuant'
  /** Retry the same request. */
  | 'retry'

export type DiffusionErrorDescription = {
  titleKey: string
  bodyKey: string
  /** Primary action; `null` when there is nothing sensible to offer. */
  action: DiffusionErrorAction | null
  /** A second choice, shown as a secondary button. */
  secondaryAction: DiffusionErrorAction | null
}

const ROUTES: Record<
  NativeDiffusionErrorCode,
  [DiffusionErrorAction | null, DiffusionErrorAction | null]
> = {
  ENGINE_MISSING: ['install', null],
  ENGINE_INSTALL_FAILED: ['install', null],
  ENGINE_CRASHED: ['retry', 'openSettings'],
  MODEL_MISSING: ['download', null],
  SIDE_FILE_MISSING: ['download', null],
  MODEL_LOAD_FAILED: ['retry', 'openSettings'],
  MODEL_INCOMPATIBLE: ['pickSmallerQuant', null],
  MODEL_NOT_LOADED: ['download', null],
  OUT_OF_MEMORY: ['reduceSize', 'pickSmallerQuant'],
  UNSUPPORTED_BACKEND: ['openSettings', null],
  UNSUPPORTED_WORKFLOW: [null, null],
  INVALID_DIMENSIONS: ['reduceSize', null],
  INVALID_REQUEST: [null, null],
  JOB_BUSY: ['retry', null],
  JOB_NOT_FOUND: [null, null],
  QUEUE_FULL: ['retry', null],
  CANCELLED: [null, null],
  DISK_FULL: ['openOutputFolder', null],
  BACKEND_IN_USE: [null, null],
  NOT_CONFIGURED: ['openSettings', null],
  INTERNAL: ['retry', null],
}

export function describeDiffusionError(
  code: NativeDiffusionErrorCode
): DiffusionErrorDescription {
  const [action, secondaryAction] = ROUTES[code] ?? ROUTES.INTERNAL
  return {
    titleKey: `images:errors.${code}.title`,
    bodyKey: `images:errors.${code}.body`,
    action,
    secondaryAction,
  }
}

/** Label key for an action button. */
export function errorActionLabelKey(action: DiffusionErrorAction): string {
  return `images:errors.actions.${action}`
}

/** Every code the contract knows, for tests that walk the table. */
export const DIFFUSION_ERROR_CODES = Object.keys(
  ROUTES
) as NativeDiffusionErrorCode[]

/**
 * Narrow an unknown rejection to the plugin's `{code, message}` shape, or
 * wrap it as `INTERNAL` so the banner always has a code to route on.
 */
export function toDiffusionError(error: unknown): {
  code: NativeDiffusionErrorCode
  message: string
  details?: string
} {
  if (error && typeof error === 'object' && 'code' in error) {
    const candidate = error as { code?: unknown; message?: unknown; details?: unknown }
    if (
      typeof candidate.code === 'string' &&
      candidate.code in ROUTES
    ) {
      return {
        code: candidate.code as NativeDiffusionErrorCode,
        message:
          typeof candidate.message === 'string' ? candidate.message : '',
        details:
          typeof candidate.details === 'string' ? candidate.details : undefined,
      }
    }
  }
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error ?? ''),
  }
}
