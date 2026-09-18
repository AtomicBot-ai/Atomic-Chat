/**
 * Domain types for Settings → Remote & LAN.
 *
 * The wire shape comes from the core's tunnel manager (`atomic-chat-core`,
 * `src/remote-access/`, `RemoteAccessStatus` in its contracts), relayed by
 * Rust. Only `lib/remoteLan.ts` reads that shape; everything else works
 * against the types below.
 *
 * PRIVACY: the tunnel URL and the LAN addresses identify the user's machine.
 * They live in memory only and must never be persisted or sent to analytics.
 * The URL is new on every start anyway, so a saved one would be wrong.
 */

export type RemoteAccessState =
  | 'off'
  | 'starting'
  | 'online'
  | 'stopping'
  | 'error'

export type RemoteAccessErrorCode =
  | 'cloudflared_unavailable'
  | 'no_url'
  | 'not_registered'
  | 'not_reachable'
  | 'exited'
  | 'stop_failed'

export type RemoteAccessBlockReason = 'server_stopped'

export type RemoteAccessStatus = {
  state: RemoteAccessState
  /** `https://<words>.trycloudflare.com`, origin only, while online. */
  url: string | null
  /** A `RemoteAccessErrorCode`, or a code this build does not know yet. */
  error: string | null
  blockReason: RemoteAccessBlockReason | null
  canStart: boolean
  canStop: boolean
  /**
   * Whether the RUNNING server was started with a non-empty key; `false` when
   * the server is stopped. The key in the store can differ until a restart.
   */
  serverHasApiKey: boolean
}

/** The core's `remote-access:status` as the relay re-emits it, with a `RemoteAccessStatus`. */
export const REMOTE_ACCESS_STATUS_EVENT = 'atomic-core://remote-access:status'

/** The tunnel at rest, and what a platform without a tunnel reports. */
export const REMOTE_ACCESS_OFF: RemoteAccessStatus = {
  state: 'off',
  url: null,
  error: null,
  blockReason: null,
  canStart: false,
  canStop: false,
  serverHasApiKey: false,
}
