import type { AccountError } from './types'

export function accountError(code: string, message: string): AccountError {
  return { code, message, attemptsLeft: null, retryAfter: null }
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/**
 * Whatever a command threw, as an `AccountError`. The Rust side rejects with
 * the object itself; a bare string (an IPC failure, a panic message) or an
 * `Error` becomes `unexpected`.
 */
export function toAccountError(error: unknown): AccountError {
  if (typeof error === 'object' && error !== null) {
    const { code, message, attemptsLeft, retryAfter } = error as Record<
      string,
      unknown
    >
    if (typeof code === 'string') {
      return {
        code,
        message: typeof message === 'string' ? message : code,
        attemptsLeft: numberOrNull(attemptsLeft),
        retryAfter: numberOrNull(retryAfter),
      }
    }
    if (error instanceof Error) return accountError('unexpected', error.message)
  }
  return accountError('unexpected', String(error))
}
