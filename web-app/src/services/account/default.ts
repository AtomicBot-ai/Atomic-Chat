/**
 * Default Account Service — no backend, so nobody is ever signed in.
 *
 * The web build and mobile have no place to keep the session safely. Status
 * reads as signed out; anything that would sign in throws.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import { accountError } from './errors'
import {
  SIGNED_OUT,
  type AccountChangedEvent,
  type AccountProfile,
  type AccountService,
  type AccountSession,
  type AccountStatus,
  type EmailChallenge,
} from './types'

const unsupported = () =>
  accountError('unexpected', 'Signing in requires the desktop app')

export class DefaultAccountService implements AccountService {
  async status(): Promise<AccountStatus> {
    return SIGNED_OUT
  }

  async providers(): Promise<string[]> {
    return []
  }

  async emailStart(_email: string): Promise<EmailChallenge> {
    throw unsupported()
  }

  async emailVerify(
    _challengeId: string,
    _code: string
  ): Promise<AccountStatus> {
    throw unsupported()
  }

  async googleLogin(): Promise<AccountStatus> {
    throw unsupported()
  }

  async cancelLogin(): Promise<void> {
    // No-op — nothing can be in flight here.
  }

  async logout(): Promise<AccountStatus> {
    return SIGNED_OUT
  }

  async profile(): Promise<AccountProfile> {
    throw unsupported()
  }

  async updateProfile(_displayName: string): Promise<AccountProfile> {
    throw unsupported()
  }

  async sessions(): Promise<AccountSession[]> {
    throw unsupported()
  }

  async revokeSession(_sessionId: string): Promise<void> {
    throw unsupported()
  }

  async deleteAccount(): Promise<AccountStatus> {
    throw unsupported()
  }

  async onChanged(
    _callback: (event: AccountChangedEvent) => void
  ): Promise<() => void> {
    return () => {}
  }
}
