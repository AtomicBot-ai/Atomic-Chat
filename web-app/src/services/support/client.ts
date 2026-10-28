/**
 * Support relay API v1 client (see `constants/support.ts`).
 *
 * Requests go through the webview's `fetch` first. When that cannot reach the
 * relay at all (the relay sends no CORS headers for the app's origin, say),
 * the Tauri HTTP plugin carries the request instead, and every later request
 * goes straight through it. An HTTP error status is an answer, never a reason
 * to retry through the plugin.
 */

import { fetch as fetchTauri } from '@tauri-apps/plugin-http'

import { SUPPORT_API_URL } from '@/constants/support'
import { isPlatformTauri } from '@/lib/platform/utils'

export type SupportAuthor = 'user' | 'team'

export type SupportConversationStatus = 'open' | 'closed'

/** A message as the relay returns it. `seq` changes with every edit. */
export type SupportWireMessage = {
  id: string
  seq: number
  author: SupportAuthor
  text: string
  created_at: string
  edited_at: string | null
  deleted: boolean
}

export type SupportGpu = {
  vendor?: string
  name?: string
  vram_gb?: number
}

/** Diagnostics attached to a conversation and, when they change, to a message. */
export type SupportMeta = {
  app_version?: string
  core_version?: string
  os_name?: string
  arch?: string
  installer_type?: string
  cpu?: string
  ram_gb?: number
  gpus?: SupportGpu[]
  backend?: string
  provider?: string
  model?: string
  locale?: string
  timezone?: string
  posthog_distinct_id?: string
}

export type SupportConversation = {
  conversation_id: string
  token: string
}

export type SupportSendResult = {
  seq: number
  created_at: string
}

export type SupportPollResult = {
  messages: SupportWireMessage[]
  status: SupportConversationStatus
}

export type SupportErrorKind = 'unauthorized' | 'rate_limited' | 'http'

/** The relay answered with an error status. */
export class SupportApiError extends Error {
  readonly status: number
  readonly kind: SupportErrorKind

  constructor(status: number, message: string) {
    super(message)
    this.name = 'SupportApiError'
    this.status = status
    this.kind =
      status === 401 ? 'unauthorized' : status === 429 ? 'rate_limited' : 'http'
  }
}

export const isSupportApiError = (
  error: unknown,
  kind?: SupportErrorKind
): error is SupportApiError =>
  error instanceof SupportApiError &&
  (kind === undefined || error.kind === kind)

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError'

type RequestOptions = {
  method: 'GET' | 'POST'
  path: string
  token?: string
  body?: unknown
  signal?: AbortSignal
  baseUrl?: string
}

// The bridge itself, not the build-time define: a desktop bundle opened in a
// plain browser has no plugin to fall back to.
const isTauriRuntime = (): boolean => isPlatformTauri()

// Set once the webview's fetch has failed to reach the relay and the plugin
// has, so later requests skip the attempt that is bound to fail.
let preferTauriFetch = false

/** Test seam: forget which fetch reached the relay. */
export const resetSupportTransport = (): void => {
  preferTauriFetch = false
}

const request = async <T>({
  method,
  path,
  token,
  body,
  signal,
  baseUrl = SUPPORT_API_URL,
}: RequestOptions): Promise<T | undefined> => {
  const url = `${baseUrl}${path}`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const init: RequestInit = {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  }

  let response: Response
  if (preferTauriFetch && isTauriRuntime()) {
    response = await (fetchTauri as typeof fetch)(url, init)
  } else {
    try {
      response = await fetch(url, init)
    } catch (primaryError) {
      if (isAbortError(primaryError) || !isTauriRuntime()) throw primaryError
      console.warn(
        '[support] fetch failed, retrying via Tauri HTTP plugin:',
        primaryError instanceof Error ? primaryError.message : primaryError
      )
      response = await (fetchTauri as typeof fetch)(url, init)
      preferTauriFetch = true
    }
  }

  if (!response.ok) {
    throw new SupportApiError(
      response.status,
      `Support relay ${method} ${path} failed: ${response.status} ${response.statusText}`
    )
  }
  if (response.status === 204) return undefined
  const text = await response.text()
  return text ? (JSON.parse(text) as T) : undefined
}

const requireBody = <T>(value: T | undefined, path: string): T => {
  if (value === undefined || value === null)
    throw new Error(`Support relay ${path} returned no body`)
  return value
}

/** Starts a conversation; its token authorises everything else. */
export const createConversation = async (
  meta: SupportMeta,
  options: { signal?: AbortSignal; baseUrl?: string } = {}
): Promise<SupportConversation> => {
  const body = requireBody(
    await request<SupportConversation>({
      method: 'POST',
      path: '/v1/conversations',
      body: { meta },
      ...options,
    }),
    '/v1/conversations'
  )
  if (!body.conversation_id || !body.token)
    throw new Error('Support relay returned an incomplete conversation')
  return { conversation_id: String(body.conversation_id), token: body.token }
}

/**
 * Sends one message. The relay deduplicates by `client_id`, so sending the
 * same message again after a lost answer is safe.
 */
export const sendMessage = async (
  token: string,
  message: { client_id: string; text: string; meta?: SupportMeta },
  options: { signal?: AbortSignal; baseUrl?: string } = {}
): Promise<SupportSendResult> =>
  requireBody(
    await request<SupportSendResult>({
      method: 'POST',
      path: '/v1/messages',
      token,
      body: message,
      ...options,
    }),
    '/v1/messages'
  )

const normalizeWireMessage = (raw: unknown): SupportWireMessage | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.id === undefined || r.id === null) return null
  if (typeof r.seq !== 'number' || !Number.isFinite(r.seq)) return null
  if (r.author !== 'user' && r.author !== 'team') return null
  return {
    id: String(r.id),
    seq: r.seq,
    author: r.author,
    text: typeof r.text === 'string' ? r.text : '',
    created_at: typeof r.created_at === 'string' ? r.created_at : '',
    edited_at: typeof r.edited_at === 'string' ? r.edited_at : null,
    deleted: r.deleted === true,
  }
}

/**
 * Changes after `after`: new messages, and edited or deleted ones again under
 * a new `seq`. With `wait` the relay holds the request until something
 * changes or the wait runs out.
 */
export const pollMessages = async (
  token: string,
  { after, wait = 0 }: { after: number; wait?: number },
  options: { signal?: AbortSignal; baseUrl?: string } = {}
): Promise<SupportPollResult> => {
  const params = new URLSearchParams({
    after: String(Math.max(0, Math.floor(after))),
    wait: String(Math.max(0, Math.min(25, Math.floor(wait)))),
  })
  const body = await request<{ messages?: unknown; status?: unknown }>({
    method: 'GET',
    path: `/v1/messages?${params.toString()}`,
    token,
    ...options,
  })
  const messages = Array.isArray(body?.messages)
    ? body.messages
        .map(normalizeWireMessage)
        .filter((m): m is SupportWireMessage => m !== null)
    : []
  return {
    messages,
    status: body?.status === 'closed' ? 'closed' : 'open',
  }
}

/** Marks the team's messages up to `seq` as read. */
export const markRead = async (
  token: string,
  seq: number,
  options: { signal?: AbortSignal; baseUrl?: string } = {}
): Promise<void> => {
  await request<void>({
    method: 'POST',
    path: '/v1/read',
    token,
    body: { seq },
    ...options,
  })
}
