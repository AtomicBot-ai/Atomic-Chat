import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauriFetch = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: tauriFetch }))

import {
  createConversation,
  isSupportApiError,
  markRead,
  pollMessages,
  resetSupportTransport,
  sendMessage,
  SupportApiError,
} from '../client'

const BASE = 'https://relay.test/support'

const reply = (status: number, body?: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }) as unknown as Response

const fetchMock = vi.fn()

const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body ? JSON.parse(init.body as string) : undefined,
  }
}

describe('support relay client', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    tauriFetch.mockReset()
    resetSupportTransport()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates a conversation with the diagnostics', async () => {
    fetchMock.mockResolvedValue(
      reply(201, { conversation_id: 'c-1', token: 'tok' })
    )

    const conversation = await createConversation(
      { app_version: '2.2.26', locale: 'en' },
      { baseUrl: BASE }
    )

    expect(conversation).toEqual({ conversation_id: 'c-1', token: 'tok' })
    const call = lastCall()
    expect(call.url).toBe(`${BASE}/v1/conversations`)
    expect(call.method).toBe('POST')
    expect(call.headers.Authorization).toBeUndefined()
    expect(call.body).toEqual({ meta: { app_version: '2.2.26', locale: 'en' } })
  })

  it('sends a message under its client id with the bearer token', async () => {
    fetchMock.mockResolvedValue(
      reply(200, { seq: 7, created_at: '2026-10-26T10:00:00Z' })
    )

    const result = await sendMessage(
      'tok',
      { client_id: 'abc', text: 'Hello' },
      { baseUrl: BASE }
    )

    expect(result).toEqual({ seq: 7, created_at: '2026-10-26T10:00:00Z' })
    const call = lastCall()
    expect(call.url).toBe(`${BASE}/v1/messages`)
    expect(call.headers.Authorization).toBe('Bearer tok')
    expect(call.body).toEqual({ client_id: 'abc', text: 'Hello' })
  })

  it('retries an unreachable relay through the Tauri plugin with the same body', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    tauriFetch.mockResolvedValue(
      reply(200, { seq: 3, created_at: '2026-10-26T10:00:00Z' })
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await sendMessage(
      'tok',
      { client_id: 'same-id', text: 'Hi' },
      { baseUrl: BASE }
    )

    expect(tauriFetch).toHaveBeenCalledTimes(1)
    const [, init] = tauriFetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: 'same-id',
      text: 'Hi',
    })

    // Later requests go straight through the plugin.
    tauriFetch.mockResolvedValue(reply(204))
    await markRead('tok', 3, { baseUrl: BASE })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(tauriFetch).toHaveBeenCalledTimes(2)
  })

  it('reports a refused token as unauthorized without retrying', async () => {
    fetchMock.mockResolvedValue(reply(401, { error: 'invalid token' }))

    const error = await sendMessage(
      'old',
      { client_id: 'x', text: 'Hi' },
      { baseUrl: BASE }
    ).catch((e) => e)

    expect(error).toBeInstanceOf(SupportApiError)
    expect(isSupportApiError(error, 'unauthorized')).toBe(true)
    expect(tauriFetch).not.toHaveBeenCalled()
  })

  it('reports a rate limit', async () => {
    fetchMock.mockResolvedValue(reply(429))

    const error = await sendMessage(
      'tok',
      { client_id: 'x', text: 'Hi' },
      { baseUrl: BASE }
    ).catch((e) => e)

    expect(isSupportApiError(error, 'rate_limited')).toBe(true)
    expect(isSupportApiError(error, 'unauthorized')).toBe(false)
  })

  it('long-polls after a seq and keeps only well-formed messages', async () => {
    fetchMock.mockResolvedValue(
      reply(200, {
        status: 'open',
        messages: [
          {
            id: 12,
            seq: 5,
            author: 'team',
            text: 'Hello from the team',
            created_at: '2026-10-26T10:00:00Z',
            edited_at: null,
            deleted: false,
          },
          { id: 'broken', author: 'team', text: 'no seq' },
          { id: 'x', seq: 6, author: 'bot', text: 'unknown author' },
        ],
      })
    )

    const result = await pollMessages(
      'tok',
      { after: 4, wait: 25 },
      { baseUrl: BASE }
    )

    expect(lastCall().url).toBe(`${BASE}/v1/messages?after=4&wait=25`)
    expect(lastCall().method).toBe('GET')
    expect(result.status).toBe('open')
    expect(result.messages).toEqual([
      {
        id: '12',
        seq: 5,
        author: 'team',
        text: 'Hello from the team',
        created_at: '2026-10-26T10:00:00Z',
        edited_at: null,
        deleted: false,
      },
    ])
  })

  it('marks messages read up to a seq', async () => {
    fetchMock.mockResolvedValue(reply(204))

    await expect(markRead('tok', 9, { baseUrl: BASE })).resolves.toBeUndefined()
    expect(lastCall().url).toBe(`${BASE}/v1/read`)
    expect(lastCall().body).toEqual({ seq: 9 })
  })

  it('passes an abort straight through', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          )
        })
    )

    const pending = pollMessages(
      'tok',
      { after: 0, wait: 25 },
      { baseUrl: BASE, signal: controller.signal }
    )
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(tauriFetch).not.toHaveBeenCalled()
  })
})
