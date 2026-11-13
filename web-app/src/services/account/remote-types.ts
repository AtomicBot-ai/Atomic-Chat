/**
 * Remote access through the account: this computer shares its models with
 * the account's other devices, and uses the models of its other computers.
 *
 * The Rust side does the pairing, the cryptography and the background work;
 * this layer sees state without keys or addresses, except the ready
 * connections the managed providers need (`remoteConnections`).
 */

/** Where this computer's public API can be reached right now. */
export interface RemoteReach {
  serverRunning: boolean
  /** The server has its own API key; sharing needs one. */
  serverHasKey: boolean
  /** `off`, `starting`, `online`, `stopping` or `error`. */
  tunnel: string
  lan: boolean
}

/** A device asking this computer for access ("Allow"). */
export interface RemotePendingRequest {
  grantId: string
  deviceName: string | null
  platform: string | null
  clientType: string
  /** The 6 digits the device shows too. */
  checkCode: string
  createdAt: string
}

/** A device this computer gave its own key. */
export interface RemoteSharedDevice {
  grantId: string
  deviceName: string | null
  platform: string | null
  /** Unix seconds. */
  issuedAt: number
}

/** The open pairing code and its QR link. */
export interface RemotePairing {
  /** `BCDF-GHJK`. */
  code: string
  /** `atomic-chat://remote/pair?c=…&k=…`, shown only as a QR code. */
  link: string
  /** Unix seconds. */
  expiresAt: number
}

/** Access this device has, or waits for, to another computer's models. */
export interface RemoteConnectionView {
  grantId: string
  hostId: string
  hostName: string
  /** `pending`, `approved` or `active`. */
  status: string
  /** It has a key and an address. */
  ready: boolean
  via: 'lan' | 'tunnel' | null
  /** For a request still waiting: the digits to compare on the host. */
  checkCode: string | null
}

export interface RemoteStatus {
  sharing: boolean
  host: { id: string; name: string } | null
  reach: RemoteReach | null
  pairing: RemotePairing | null
  requests: RemotePendingRequest[]
  devices: RemoteSharedDevice[]
  connections: RemoteConnectionView[]
  hostError: string | null
}

export const EMPTY_REMOTE_STATUS: RemoteStatus = {
  sharing: false,
  host: null,
  reach: null,
  pairing: null,
  requests: [],
  devices: [],
  connections: [],
  hostError: null,
}

/** One of the account's computers. Never carries an address. */
export interface RemoteHostInfo {
  id: string
  name: string
  clientType: string
  platform: string | null
  online: boolean
  tunnelState: string | null
  lanEnabled: boolean
  lastSeenAt: string | null
  createdAt: string
  /** This computer. */
  isSelf: boolean
  /** This device's grant on it, if any. */
  myGrant: { id: string; status: string } | null
}

/**
 * A ready connection, for its managed provider. Carries the key, which the
 * provider stores like any other provider key.
 */
export interface RemoteProviderConnection {
  hostId: string
  hostName: string
  baseUrl: string
  apiKey: string
  /**
   * The sequence number of the host's address list. A newer one lists the
   * host's models again, even when the address stays the same.
   */
  endpointsSeq: number
}

/** Payload of `account-remote-connection-ended`. */
export interface RemoteConnectionEnded {
  hostName: string
  /** `denied`, `revoked_by_user`, `signed_out`, `untrusted_credential`, … */
  reason: string
}

export interface RemoteAccessService {
  remoteStatus(): Promise<RemoteStatus>
  remoteConnections(): Promise<RemoteProviderConnection[]>
  /** The caller has made sure the server has a key and is reachable. */
  remoteSetSharing(enabled: boolean): Promise<RemoteStatus>
  remotePairingCode(): Promise<RemotePairing>
  remoteClosePairingCode(): Promise<void>
  remoteDecide(grantId: string, allow: boolean): Promise<RemoteStatus>
  remoteRevoke(grantId: string): Promise<RemoteStatus>
  remoteHosts(): Promise<RemoteHostInfo[]>
  /** Ask a host for access; resolves with the check code to compare. */
  remoteRequest(hostId: string): Promise<RemoteConnectionView>
  /** A typed code from a host's screen, or a pasted pair link. */
  remotePair(input: string): Promise<RemoteConnectionView>
  remoteDisconnect(hostId: string): Promise<RemoteStatus>
  /** Remove a computer from the account (e.g. a lost laptop). */
  remoteRemoveHost(hostId: string): Promise<RemoteStatus>
  onRemoteChanged(callback: (status: RemoteStatus) => void): Promise<() => void>
  onRemoteConnections(
    callback: (connections: RemoteProviderConnection[]) => void
  ): Promise<() => void>
  onRemoteConnectionEnded(
    callback: (event: RemoteConnectionEnded) => void
  ): Promise<() => void>
}
