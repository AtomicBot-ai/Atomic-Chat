/**
 * Pure helpers behind Settings → Remote & LAN.
 *
 * This is the single boundary between the Rust tunnel manager's wire shape and
 * the app's domain types (tolerant of snake_case and camelCase, so a serde
 * rename cannot blank the page), plus the state → label/tone/message rules the
 * two cards share. No React and no stores, so every rule is testable on its
 * own.
 */

import type { StatusTone } from '@/containers/api/ApiStatusIndicators'
import type {
  RemoteAccessBlockReason,
  RemoteAccessErrorCode,
  RemoteAccessState,
  RemoteAccessStatus,
} from '@/types/remoteAccess'

type Raw = Record<string, unknown>

const asRecord = (value: unknown): Raw | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Raw)
    : null

/** Reads the first present key, accepting camelCase and snake_case. */
function pick(raw: Raw, keys: string[]): unknown {
  for (const key of keys) {
    const value = raw[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

const pickText = (raw: Raw, keys: string[]): string | null => {
  const value = pick(raw, keys)
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

const pickFlag = (raw: Raw, keys: string[]): boolean =>
  pick(raw, keys) === true

const REMOTE_ACCESS_STATES: readonly RemoteAccessState[] = [
  'off',
  'starting',
  'online',
  'stopping',
  'error',
]

const REMOTE_ACCESS_ERROR_CODES: readonly RemoteAccessErrorCode[] = [
  'cloudflared_unavailable',
  'no_url',
  'not_registered',
  'not_reachable',
  'exited',
  'stop_failed',
]

const SERVER_STOPPED: RemoteAccessBlockReason = 'server_stopped'

/**
 * `null` for anything that is not a status: callers keep what they had rather
 * than render a half-read payload.
 */
export function normalizeRemoteAccessStatus(
  raw: unknown
): RemoteAccessStatus | null {
  const record = asRecord(raw)
  if (!record) return null

  const state = record.state
  if (
    typeof state !== 'string' ||
    !REMOTE_ACCESS_STATES.includes(state as RemoteAccessState)
  ) {
    return null
  }

  return {
    state: state as RemoteAccessState,
    url: pickText(record, ['url']),
    error: pickText(record, ['error']),
    blockReason:
      pickText(record, ['blockReason', 'block_reason']) === SERVER_STOPPED
        ? SERVER_STOPPED
        : null,
    canStart: pickFlag(record, ['canStart', 'can_start']),
    canStop: pickFlag(record, ['canStop', 'can_stop']),
    serverHasApiKey: pickFlag(record, [
      'serverHasApiKey',
      'server_has_api_key',
    ]),
  }
}

export const REMOTE_ACCESS_TONE: Record<RemoteAccessState, StatusTone> = {
  off: 'idle',
  starting: 'pending',
  online: 'ready',
  stopping: 'pending',
  error: 'error',
}

/**
 * LAN access has no process of its own: it is the Local API Server bound on
 * every interface, so its state is derived from the server's.
 */
export type LanAccessState = 'off' | 'starting' | 'online'

export const LAN_ACCESS_TONE: Record<LanAccessState, StatusTone> = {
  off: 'idle',
  starting: 'pending',
  online: 'ready',
}

export function lanAccessState(
  serverStatus: 'running' | 'stopped' | 'pending',
  serverHost: string
): LanAccessState {
  if (serverHost !== '0.0.0.0') return 'off'
  if (serverStatus === 'running') return 'online'
  if (serverStatus === 'pending') return 'starting'
  return 'off'
}

/**
 * The prefix as it belongs in a base URL: one leading slash, no trailing one,
 * and nothing at all for a bare `/`. OpenAI clients append `/chat/completions`
 * themselves, so a trailing slash here becomes `//` on the wire.
 */
function normalizeApiPrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, '')
  return trimmed === '' ? '' : `/${trimmed}`
}

/** `http://<ip>:<port><prefix>` for every address, in the order given. */
export function buildLanAccessUrls(
  addresses: readonly string[],
  port: number,
  prefix: string
): string[] {
  const path = normalizeApiPrefix(prefix)
  const hosts = addresses
    .map((address) => address.trim())
    .filter((address) => address !== '')
  return [...new Set(hosts)].map((host) => {
    // The contract is IPv4 only; brackets keep an IPv6 address a valid URL.
    const authority = host.includes(':') ? `[${host}]` : host
    return `http://${authority}:${port}${path}`
  })
}

/**
 * What a client pastes as its base URL: the tunnel's origin plus the API
 * prefix, e.g. `https://x.trycloudflare.com/v1`.
 */
export function buildRemoteApiUrl(
  url: string | null | undefined,
  prefix: string
): string | null {
  const trimmed = url?.trim()
  if (!trimmed) return null
  let origin: string
  try {
    origin = new URL(trimmed).origin
  } catch {
    origin = trimmed.replace(/\/+$/, '')
  }
  return `${origin}${normalizeApiPrefix(prefix)}`
}

export type AccessAction = 'start' | 'stop'

/** Which way the card's single button points. */
export function remoteAccessAction(
  status: RemoteAccessStatus | null
): AccessAction {
  if (!status) return 'start'
  if (
    status.state === 'starting' ||
    status.state === 'online' ||
    status.state === 'stopping'
  ) {
    return 'stop'
  }
  // A stop that could not be confirmed parks the tunnel in `error` with only
  // Stop allowed; offering Start there would leave no way to retry the stop.
  return !status.canStart && status.canStop ? 'stop' : 'start'
}

export function isRemoteAccessActionAllowed(
  status: RemoteAccessStatus | null,
  action: AccessAction
): boolean {
  if (!status) return false
  if (action === 'stop') return status.canStop
  // The page starts the Local API Server itself before it asks for a tunnel,
  // so a stopped server is not a reason to grey Start out.
  return status.canStart || status.blockReason === SERVER_STOPPED
}

export type RemoteAccessRejection =
  | { kind: 'blocked'; blockReason: RemoteAccessBlockReason }
  | { kind: 'failed'; code: string }

/**
 * Keeps a value only if it is shaped like one of Rust's machine codes, and
 * collapses everything else to `unknown`. Codes end up in telemetry, and
 * free-form error text can carry a hostname or an address.
 */
export function toFailureCode(value: string | null | undefined): string {
  const text = value?.trim() ?? ''
  return /^[a-z][a-z0-9_]{0,63}$/.test(text) ? text : 'unknown'
}

function rejectionText(error: unknown): string {
  if (typeof error === 'string') return error
  const record = asRecord(error)
  if (record && typeof record.message === 'string') return record.message
  return ''
}

/** Rust rejects `start`/`stop` with a bare code string. */
export function parseRemoteAccessRejection(
  error: unknown
): RemoteAccessRejection {
  const text = rejectionText(error).trim()
  if (text === SERVER_STOPPED) {
    return { kind: 'blocked', blockReason: SERVER_STOPPED }
  }
  return { kind: 'failed', code: toFailureCode(text) }
}

export type AccessMessageTone = 'muted' | 'warning' | 'destructive'

export type AccessMessage = {
  key: string
  tone: AccessMessageTone
  params?: Record<string, unknown>
}

const REMOTE_SERVER_STOPPED: AccessMessage = {
  key: 'settings:remoteLan.remote.block.serverStopped',
  tone: 'muted',
}

function remoteErrorMessage(code: string): AccessMessage {
  return REMOTE_ACCESS_ERROR_CODES.includes(code as RemoteAccessErrorCode)
    ? { key: `settings:remoteLan.remote.error.${code}`, tone: 'destructive' }
    : {
        key: 'settings:remoteLan.remote.error.unknown',
        tone: 'destructive',
        params: { code },
      }
}

/**
 * The one line under the Remote access header. Highest priority first: the
 * backend cannot do this at all → what the last click ran into → what the
 * tunnel itself reports → why Start would not work yet → the standing warning.
 */
export function remoteAccessMessage({
  unavailable,
  rejection,
  status,
  hasApiKey,
}: {
  unavailable: boolean
  rejection: RemoteAccessRejection | null
  status: RemoteAccessStatus | null
  hasApiKey: boolean
}): AccessMessage | null {
  if (unavailable) {
    return { key: 'settings:remoteLan.remote.unavailable', tone: 'muted' }
  }
  if (rejection) {
    return rejection.kind === 'blocked'
      ? REMOTE_SERVER_STOPPED
      : remoteErrorMessage(rejection.code)
  }
  if (status && (status.error || status.state === 'error')) {
    return remoteErrorMessage(status.error ?? 'unknown')
  }
  if (status?.blockReason === SERVER_STOPPED) return REMOTE_SERVER_STOPPED
  if (!hasApiKey) {
    return { key: 'settings:remoteLan.noKeyWarning', tone: 'warning' }
  }
  return null
}

/**
 * The one line under the LAN access header. `addresses` is `null` until the
 * first lookup returns, so an empty list is only reported once it is real.
 */
export function lanAccessMessage({
  state,
  serverStatus,
  serverHost,
  addresses,
  hasApiKey,
}: {
  state: LanAccessState
  serverStatus: 'running' | 'stopped' | 'pending'
  serverHost: string
  addresses: readonly string[] | null
  hasApiKey: boolean
}): AccessMessage | null {
  if (state === 'online' && addresses !== null && addresses.length === 0) {
    return { key: 'settings:remoteLan.lan.block.noAddresses', tone: 'warning' }
  }
  if (serverStatus === 'stopped') {
    return { key: 'settings:remoteLan.lan.block.serverStopped', tone: 'muted' }
  }
  if (serverStatus === 'running' && serverHost !== '0.0.0.0') {
    return { key: 'settings:remoteLan.lan.block.loopbackOnly', tone: 'muted' }
  }
  if (state !== 'off' && !hasApiKey) {
    return { key: 'settings:remoteLan.lan.noKeyWarning', tone: 'warning' }
  }
  return null
}
