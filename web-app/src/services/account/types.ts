/**
 * Account Service Types
 *
 * Signing in to an Atomic Chat account (api.atomic.chat). The Rust side owns
 * the session and its tokens; this layer only ever sees status and profile
 * DTOs. Every command rejects with an `AccountError` object.
 */

import type { RemoteAccessService } from './remote-types'

/** Why a command failed. `code` is the backend's or one of the client's own. */
export interface AccountError {
  /**
   * Backend: invalid_code, code_expired, too_many_attempts, invalid_challenge,
   * rate_limited, email_unavailable, invalid_request, reauth_required,
   * invalid_token, invalid_grant, access_denied, unverified_email,
   * account_disabled, server_error. Client: network, not_signed_in,
   * cancelled, timeout, unexpected.
   */
  code: string
  message: string
  /** With invalid_code: how many tries the challenge has left. */
  attemptsLeft: number | null
  /** With rate_limited: seconds to wait before trying again. */
  retryAfter: number | null
}

export interface AccountUser {
  id: string
  email: string
  displayName: string | null
  avatarUrl: string | null
}

export interface AccountStatus {
  signedIn: boolean
  user: AccountUser | null
}

/** A one-time code sent by email. Times are seconds. */
export interface EmailChallenge {
  challengeId: string
  expiresIn: number
  resendIn: number
}

/** One way to sign in to the account: `email` (one-time code) or `google`. */
export interface AccountIdentity {
  provider: string
  email: string | null
  createdAt: string
}

export interface AccountProfile {
  user: AccountUser
  createdAt: string
  identities: AccountIdentity[]
}

/** One signed-in device or client of the account. */
export interface AccountSession {
  id: string
  clientType: string
  deviceName: string | null
  platform: string | null
  appVersion: string | null
  authMethod: string
  createdAt: string
  lastUsedAt: string
  expiresAt: string
  /** This app's own session. */
  current: boolean
}

export type AccountChangeReason =
  | 'signedIn'
  | 'signedOut'
  | 'sessionLost'
  | 'profileUpdated'
  | 'deleted'

/** Payload of the `account-changed` event. */
export interface AccountChangedEvent {
  status: AccountStatus
  reason: AccountChangeReason
}

export const SIGNED_OUT: AccountStatus = { signedIn: false, user: null }

/** The account, and remote access through it (`remote-types.ts`). */
export interface AccountService extends RemoteAccessService {
  /** What is on disk; no network. */
  status(): Promise<AccountStatus>
  /** Sign-in methods the backend offers, e.g. `["email", "google"]`. */
  providers(): Promise<string[]>
  emailStart(email: string): Promise<EmailChallenge>
  emailVerify(challengeId: string, code: string): Promise<AccountStatus>
  /**
   * Opens the system browser and resolves once the round trip is done.
   * Rejects with `cancelled`, `timeout`, `access_denied`, …
   */
  googleLogin(): Promise<AccountStatus>
  cancelLogin(): Promise<void>
  /** Always ends signed out locally. */
  logout(): Promise<AccountStatus>
  /** The account from the backend; also refreshes the cached user. */
  profile(): Promise<AccountProfile>
  updateProfile(displayName: string): Promise<AccountProfile>
  sessions(): Promise<AccountSession[]>
  revokeSession(sessionId: string): Promise<void>
  /** Rejects with `reauth_required` when the last sign-in is too old. */
  deleteAccount(): Promise<AccountStatus>
  /** Follows `account-changed`; resolves with the unsubscribe. */
  onChanged(callback: (event: AccountChangedEvent) => void): Promise<() => void>
}
