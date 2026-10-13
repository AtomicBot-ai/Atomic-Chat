/**
 * Shared HTTP plumbing for the cloud and A1111 adapters.
 *
 * Every adapter here talks to a different wire format, but they all need the
 * same handful of things done the same way: the caller's `AbortSignal`
 * honoured exactly, a deadline when there is no caller to impose one, a
 * credential resolved per request and never cached, provider errors mapped to
 * something retry logic can act on, and snapshots built without forgetting a
 * field. Doing those once is what keeps four adapters from drifting.
 *
 * Nothing in this module knows about a particular provider.
 */

import type {
  MediaJobError,
  MediaJobHandle,
  MediaJobSnapshot,
  MediaProviderDescriptor,
} from '../contract'
import type { MediaSecretResolver } from './remoteHttp'

export type { MediaSecretResolver } from './remoteHttp'

/** The transport an adapter uses. `fetch`-shaped so tests can stub it. */
export type MediaTransport = (
  input: string,
  init?: RequestInit
) => Promise<Response>

/** Options every HTTP adapter in this family accepts. */
export type MediaHttpAdapterOptions = {
  /**
   * Defaults to the global `fetch`, looked up at call time so a test's stub
   * is honoured. The app injects the Tauri HTTP client, because the webview's
   * `fetch` is subject to CORS and not every provider allows it.
   */
  fetch?: MediaTransport
  resolveSecret?: MediaSecretResolver
}

/**
 * How long a request may take when the caller did not pass a signal.
 *
 * The caller's signal always wins: it is passed through untouched, because a
 * caller that supplied one owns the decision of when to give up. Without one
 * (the job manager polls without a signal) a hung connection would otherwise
 * stall that job's polling for ever.
 */
export const MEDIA_HTTP_TIMEOUT_MS = {
  /** Health, capabilities, status polls, cancel. */
  metadata: 30_000,
  /** A synchronous generation, where the body *is* the work. */
  generation: 180_000,
} as const

/** An error a provider answered with, or a failure to reach it. */
export class MediaHttpError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    /** Whether trying the same request again later could succeed. */
    readonly retryable: boolean = false,
    /** How long the provider asked the caller to wait, when it said. */
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'MediaHttpError'
  }
}

/** The caller's signal if there is one, otherwise a deadline. */
export function signalWithDeadline(
  signal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal | undefined {
  if (signal) return signal
  return typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
}

/** A human sentence for a thrown value, without leaking request details. */
export function describeFailure(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    if (error.name === 'TimeoutError') return 'The request timed out.'
    if (error.name === 'AbortError') return 'The request was cancelled.'
  }
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Statuses worth retrying: timeouts, rate limits and server-side failures.
 * Everything else in 4xx is the request or the account, and repeating it would
 * fail the same way.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/** A stable, provider-independent error code for an HTTP status. */
export function codeForStatus(status: number): string {
  if (status === 401 || status === 403) return 'unauthorised'
  if (status === 402) return 'insufficient_credit'
  if (status === 404) return 'not_found'
  if (status === 408 || status === 504) return 'timeout'
  if (status === 413) return 'payload_too_large'
  if (status === 400 || status === 422) return 'invalid_request'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'provider_unavailable'
  return `http_${status}`
}

/**
 * `Retry-After` in milliseconds. RFC 9110 allows delay-seconds or an
 * HTTP-date; anything else is ignored rather than guessed at.
 */
export function retryAfterMs(
  value: string | null | undefined,
  now: number = Date.now()
): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}

/** The body as JSON, or `undefined` when there is none or it is not JSON. */
export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Strip the `${provider_id}:` qualifier the contract puts on model ids. */
export function localModelId(
  descriptor: MediaProviderDescriptor,
  modelId: string
): string {
  return modelId.startsWith(`${descriptor.id}:`)
    ? modelId.slice(descriptor.id.length + 1)
    : modelId
}

/** `base_url` without trailing slashes, or the provider's default. */
export function baseUrlOf(
  descriptor: MediaProviderDescriptor,
  fallback: string
): string {
  return (descriptor.base_url?.trim() || fallback).replace(/\/+$/, '')
}

/** Whether `url` is on the same origin as `base`. */
export function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin
  } catch {
    return false
  }
}

/** A snapshot with every optional field set, so none is forgotten. */
export function snapshotFor(
  descriptor: MediaProviderDescriptor,
  handle: MediaJobHandle,
  providerJobId: string | undefined,
  state: MediaJobSnapshot['state'],
  extra: Partial<MediaJobSnapshot> = {}
): MediaJobSnapshot {
  return {
    client_job_id: handle.client_job_id,
    provider_job_id: providerJobId,
    provider_id: descriptor.id,
    state,
    progress: null,
    step: null,
    queue_position: null,
    outputs: [],
    error: null,
    ...extra,
  }
}

/** The structured error a failed snapshot carries, from anything thrown. */
export function jobErrorFrom(
  error: unknown,
  fallbackCode = 'transport_error'
): MediaJobError {
  if (error instanceof MediaHttpError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    }
  }
  return {
    code: isAbortError(error) ? 'timeout' : fallbackCode,
    message: describeFailure(error),
    // A transport failure says nothing about the job itself.
    retryable: true,
  }
}

/**
 * Resolve the credential a descriptor points at.
 *
 * Returns `undefined` for a provider configured without authentication, and
 * throws `no_api_key` - before any request is built - for one that should have
 * a credential but does not. Sending a blank header instead would turn an
 * actionable "no key configured" into an opaque 401.
 *
 * The secret is returned to the caller and never stored. Nothing here puts it
 * into a message.
 */
export async function resolveCredential(
  descriptor: MediaProviderDescriptor,
  resolveSecret: MediaSecretResolver | undefined
): Promise<string | undefined> {
  const auth = descriptor.auth
  if (!auth || auth.type === 'none') return undefined
  const missing = () =>
    new MediaHttpError(
      `Provider "${descriptor.label}" has no API key configured.`,
      'no_api_key'
    )
  if (!auth.setting_key || !resolveSecret) throw missing()
  const secret = (await resolveSecret(auth.setting_key))?.trim()
  if (!secret) throw missing()
  return secret
}

/** The global `fetch`, resolved per call so a test stub is seen. */
export const globalTransport: MediaTransport = (input, init) =>
  globalThis.fetch(input, init)

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
}

/** A MIME type from a format name (`png`) or a URL's extension. */
export function mimeFromName(name: string | undefined): string | undefined {
  if (!name) return undefined
  const extension = name.split(/[?#]/)[0]?.split('.').pop()?.toLowerCase()
  return extension ? MIME_BY_EXTENSION[extension] : undefined
}

/** A MIME type from the first bytes of base64 image data. */
export function mimeFromBase64(base64: string): string | undefined {
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png'
  if (base64.startsWith('/9j/')) return 'image/jpeg'
  if (base64.startsWith('UklGR')) return 'image/webp'
  if (base64.startsWith('R0lGOD')) return 'image/gif'
  return undefined
}

const DATA_URL = /^data:([^;,]+)?(;base64)?,(.*)$/s

export function isDataUrl(value: unknown): value is string {
  return typeof value === 'string' && DATA_URL.test(value)
}

/** Decode a base64 data URL into a Blob, for a multipart upload. */
export function blobFromDataUrl(dataUrl: string): Blob {
  const match = DATA_URL.exec(dataUrl)
  if (!match || !match[2]) {
    throw new MediaHttpError(
      'An image must be supplied as a base64 data URL.',
      'invalid_params'
    )
  }
  const binary = atob(match[3] ?? '')
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: match[1] ?? 'application/octet-stream' })
}

/**
 * Remove the credential a request carried from text a provider sent back.
 *
 * Some providers echo the key in their error message - Stability's v1 API
 * answers a bad key with "Incorrect API key provided: <the key>". Health
 * details and job errors are shown in the UI and can reach logs, so the
 * provider's words are kept but the credential is not.
 */
export function redactCredentials(
  text: string,
  sentHeaders: Record<string, string> | undefined
): string {
  const authorization = sentHeaders?.Authorization ?? sentHeaders?.authorization
  if (!authorization) return text
  const [scheme, token] = authorization.split(/\s+/, 2)
  if (!token) return text
  const secrets = [token]
  if (scheme?.toLowerCase() === 'basic') {
    try {
      const decoded = atob(token)
      const password = decoded.slice(decoded.indexOf(':') + 1)
      secrets.push(decoded)
      if (password) secrets.push(password)
    } catch {
      // Not valid base64: only the token itself is redacted.
    }
  }
  let redacted = text
  for (const secret of secrets.sort((a, b) => b.length - a.length)) {
    if (secret.length >= 4) redacted = redacted.split(secret).join('[redacted]')
  }
  return redacted
}
