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
import type {
  RemoteConnectionEnded,
  RemoteConnectionView,
  RemoteHostInfo,
  RemotePairing,
  RemoteProviderConnection,
  RemoteStatus,
} from './remote-types'

const CHANGED_EVENT = 'account-changed'
const REMOTE_CHANGED_EVENT = 'account-remote-changed'
const REMOTE_CONNECTIONS_EVENT = 'account-remote-connections'
const REMOTE_CONNECTION_ENDED_EVENT = 'account-remote-connection-ended'

async function follow<T>(
  event: string,
  callback: (payload: T) => void
): Promise<() => void> {
  const unlisten = await listen<T>(event, (e) => callback(e.payload))
  const detach = createSafeUnlisten(unlisten)
  return () => void detach()
}

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

  async remoteStatus(): Promise<RemoteStatus> {
    return call<RemoteStatus>('account_remote_status')
  }

  async remoteConnections(): Promise<RemoteProviderConnection[]> {
    return call<RemoteProviderConnection[]>('account_remote_connections')
  }

  async remoteSetSharing(enabled: boolean): Promise<RemoteStatus> {
    return call<RemoteStatus>('account_remote_set_sharing', { enabled })
  }

  async remotePairingCode(): Promise<RemotePairing> {
    return call<RemotePairing>('account_remote_pairing_code')
  }

  async remoteClosePairingCode(): Promise<void> {
    await call<void>('account_remote_close_pairing_code')
  }

  async remoteDecide(grantId: string, allow: boolean): Promise<RemoteStatus> {
    return call<RemoteStatus>('account_remote_decide', { grantId, allow })
  }

  async remoteRevoke(grantId: string): Promise<RemoteStatus> {
    return call<RemoteStatus>('account_remote_revoke', { grantId })
  }

  async remoteHosts(): Promise<RemoteHostInfo[]> {
    return call<RemoteHostInfo[]>('account_remote_hosts')
  }

  async remoteRequest(hostId: string): Promise<RemoteConnectionView> {
    return call<RemoteConnectionView>('account_remote_request', { hostId })
  }

  async remotePair(input: string): Promise<RemoteConnectionView> {
    return call<RemoteConnectionView>('account_remote_pair', { input })
  }

  async remoteDisconnect(hostId: string): Promise<RemoteStatus> {
    return call<RemoteStatus>('account_remote_disconnect', { hostId })
  }

  async remoteRemoveHost(hostId: string): Promise<RemoteStatus> {
    return call<RemoteStatus>('account_remote_remove_host', { hostId })
  }

  async onRemoteChanged(
    callback: (status: RemoteStatus) => void
  ): Promise<() => void> {
    return follow(REMOTE_CHANGED_EVENT, callback)
  }

  async onRemoteConnections(
    callback: (connections: RemoteProviderConnection[]) => void
  ): Promise<() => void> {
    return follow(REMOTE_CONNECTIONS_EVENT, callback)
  }

  async onRemoteConnectionEnded(
    callback: (event: RemoteConnectionEnded) => void
  ): Promise<() => void> {
    return follow(REMOTE_CONNECTION_ENDED_EVENT, callback)
  }
}
