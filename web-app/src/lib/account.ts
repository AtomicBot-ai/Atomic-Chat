/**
 * Display helpers for the Atomic Chat account: names, initials and the words
 * a failed account command is shown with.
 */

import type { AccountError, AccountUser } from '@/services/account/types'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** The name the account goes by: its display name, else its email. */
export function accountLabel(user: AccountUser): string {
  return user.displayName?.trim() || user.email
}

/** "Ada Lovelace" → "AL", "ada" → "A"; without a name, the email's first letter. */
export function accountInitials(user: AccountUser): string {
  const words = (user.displayName ?? '').trim().split(/\s+/).filter(Boolean)
  const letters =
    words.length > 0
      ? words
          .slice(0, 2)
          .map((word) => Array.from(word)[0])
          .join('')
      : (Array.from(user.email.trim())[0] ?? '')
  return letters.toLocaleUpperCase()
}

/** `m:ss`, for a countdown that is at most a few minutes long. */
export function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds))
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

/** "Wait 30 seconds" / "Wait 15 minutes", for `rate_limited`'s `retryAfter`. */
function retryAfterMessage(t: Translate, seconds: number | null): string {
  if (seconds === null || seconds <= 0) return t('account:errors.rateLimited')
  if (seconds < 60)
    return t('account:errors.rateLimitedSeconds', {
      count: Math.ceil(seconds),
    })
  return t('account:errors.rateLimitedMinutes', {
    count: Math.ceil(seconds / 60),
  })
}

const MESSAGE_KEYS: Record<string, string> = {
  code_expired: 'account:errors.codeExpired',
  too_many_attempts: 'account:errors.tooManyAttempts',
  invalid_challenge: 'account:errors.invalidChallenge',
  email_unavailable: 'account:errors.emailUnavailable',
  invalid_request: 'account:errors.invalidRequest',
  reauth_required: 'account:errors.reauthRequired',
  invalid_token: 'account:errors.signedOut',
  invalid_grant: 'account:errors.signedOut',
  not_signed_in: 'account:errors.signedOut',
  access_denied: 'account:errors.accessDenied',
  unverified_email: 'account:errors.unverifiedEmail',
  account_disabled: 'account:errors.accountDisabled',
  server_error: 'account:errors.serverError',
  network: 'account:errors.network',
  timeout: 'account:errors.timeout',
}

/**
 * What to tell the user about a failed account command, or `null` when there
 * is nothing to say (`cancelled`: the user stopped it themselves). `overrides`
 * maps a code to a key for the one place that knows better, e.g.
 * `invalid_request` on the email step means the address itself.
 */
export function accountErrorMessage(
  t: Translate,
  error: AccountError,
  overrides: Record<string, string> = {}
): string | null {
  if (error.code === 'cancelled') return null
  const override = overrides[error.code]
  if (override) return t(override)
  if (error.code === 'invalid_code') {
    return error.attemptsLeft === null
      ? t('account:errors.invalidCode')
      : t('account:errors.invalidCodeAttempts', { count: error.attemptsLeft })
  }
  if (error.code === 'rate_limited')
    return retryAfterMessage(t, error.retryAfter)
  return t(MESSAGE_KEYS[error.code] ?? 'account:errors.unexpected')
}

const PLATFORM_LABELS: Record<string, string> = {
  macos: 'macOS',
  darwin: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  ios: 'iOS',
  android: 'Android',
  web: 'Web',
}

/**
 * `macos` → "macOS"; Atomic Server's `atc-linux` → "Linux"; an unknown
 * platform reads as the backend sent it.
 */
export function platformLabel(platform: string | null): string | null {
  if (!platform) return null
  const key = platform.toLowerCase().replace(/^atc-/, '')
  return PLATFORM_LABELS[key] ?? platform
}
