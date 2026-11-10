/**
 * Tauri Account Service — desktop implementation.
 *
 * Every method is a command round trip; no token ever crosses this boundary.
 * A rejection is always rethrown as an `AccountError`, so callers can switch
 * on `code` even when the IPC layer itself failed with a string.
 * `account_google_login` is long-running by design: it resolves only once the
 * system-browser round trip is done.
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createSafeUnlisten } from '@/lib/tauriEvent'
import { DefaultAccountService } from './default'
import { toAccountError } from './errors'
import type {
  AccountChangedEvent,
  AccountProfile,
  AccountSession,
  AccountStatus,
  EmailChallenge,
} from './types'

const CHANGED_EVENT = 'account-changed'

async function call<T>(command: string, args?: InvokeArgs): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    throw toAccountError(error)
  }
}

export class TauriAccountService extends DefaultAccountService {
  async status(): Promise<AccountStatus> {
    return call<AccountStatus>('account_status')
  }

  async providers(): Promise<string[]> {
    return call<string[]>('account_providers')
  }

  async emailStart(email: string): Promise<EmailChallenge> {
    return call<EmailChallenge>('account_email_start', { email })
  }

  async emailVerify(challengeId: string, code: string): Promise<AccountStatus> {
    return call<AccountStatus>('account_email_verify', { challengeId, code })
  }

  async googleLogin(): Promise<AccountStatus> {
    return call<AccountStatus>('account_google_login')
  }

  async cancelLogin(): Promise<void> {
    await call<void>('account_cancel_login')
  }

  async logout(): Promise<AccountStatus> {
    return call<AccountStatus>('account_logout')
  }

  async profile(): Promise<AccountProfile> {
    return call<AccountProfile>('account_profile')
  }

  async updateProfile(displayName: string): Promise<AccountProfile> {
    return call<AccountProfile>('account_update_profile', { displayName })
  }

  async sessions(): Promise<AccountSession[]> {
    return call<AccountSession[]>('account_sessions')
  }

  async revokeSession(sessionId: string): Promise<void> {
    await call<void>('account_revoke_session', { sessionId })
  }

  async deleteAccount(): Promise<AccountStatus> {
    return call<AccountStatus>('account_delete')
  }

  async onChanged(
    callback: (event: AccountChangedEvent) => void
  ): Promise<() => void> {
    const unlisten = await listen<AccountChangedEvent>(CHANGED_EVENT, (event) =>
      callback(event.payload)
    )
    const detach = createSafeUnlisten(unlisten)
    return () => void detach()
  }
}
