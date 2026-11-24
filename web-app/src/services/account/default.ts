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
import {
  EMPTY_REMOTE_STATUS,
  type RemoteConnectionEnded,
  type RemoteDeviceLeft,
  type RemoteConnectionView,
  type RemoteHostInfo,
  type RemotePairing,
  type RemoteProviderConnection,
  type RemoteStatus,
} from './remote-types'

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

  async remoteStatus(): Promise<RemoteStatus> {
    return EMPTY_REMOTE_STATUS
  }

  async remoteConnections(): Promise<RemoteProviderConnection[]> {
    return []
  }

  async remoteSetSharing(_enabled: boolean): Promise<RemoteStatus> {
    throw unsupported()
  }

  async remotePairingCode(): Promise<RemotePairing> {
    throw unsupported()
  }

  async remoteClosePairingCode(): Promise<void> {
    throw unsupported()
  }

  async remoteDecide(_grantId: string, _allow: boolean): Promise<RemoteStatus> {
    throw unsupported()
  }

  async remoteRevoke(_grantId: string): Promise<RemoteStatus> {
    throw unsupported()
  }

  async remoteHosts(): Promise<RemoteHostInfo[]> {
    return []
  }

  async remoteRequest(_hostId: string): Promise<RemoteConnectionView> {
    throw unsupported()
  }

  async remotePair(_input: string): Promise<RemoteConnectionView> {
    throw unsupported()
  }

  async remoteDisconnect(_hostId: string): Promise<RemoteStatus> {
    throw unsupported()
  }

  async remoteRemoveHost(_hostId: string): Promise<RemoteStatus> {
    throw unsupported()
  }

  async onRemoteChanged(
    _callback: (status: RemoteStatus) => void
  ): Promise<() => void> {
    return () => {}
  }

  async onRemoteConnections(
    _callback: (connections: RemoteProviderConnection[]) => void
  ): Promise<() => void> {
    return () => {}
  }

  async onRemoteConnectionEnded(
    _callback: (event: RemoteConnectionEnded) => void
  ): Promise<() => void> {
    return () => {}
  }

  async onRemoteDeviceLeft(
    _callback: (event: RemoteDeviceLeft) => void
  ): Promise<() => void> {
    return () => {}
  }
}
