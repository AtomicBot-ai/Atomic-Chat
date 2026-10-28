import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  EmailReminderError,
  notifyEmailReminder,
  registerEmailReminder,
  REMINDER_TIMEOUT_MS,
} from '../email-reminders'

const mocks = vi.hoisted(() => ({ native: vi.fn(), tauri: false }))
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: mocks.native }))
vi.mock('@/lib/platform/utils', () => ({ isPlatformTauri: () => mocks.tauri }))
const token = 'a'.repeat(64)
const body = { email: 'test@example.com', locale: 'en', model_name: 'Qwen 4B' }
const browser = vi.fn()

describe('reminder API contract', () => {
  beforeEach(() => {
    mocks.tauri = false
    mocks.native.mockReset()
    browser.mockReset()
    vi.stubGlobal('fetch', browser)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('registers by PUT with the install bearer and accepts an empty 204', async () => {
    browser.mockResolvedValue(new Response(null, { status: 204 }))
    await registerEmailReminder(token, body)
    expect(browser).toHaveBeenCalledExactlyOnceWith(
      'https://api.atomic.chat/v1/reminders',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify(body),
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })
    )
  })

  it('uses native HTTP in Tauri and accepts an empty 202 for notify', async () => {
    mocks.tauri = true
    mocks.native.mockResolvedValue(new Response(null, { status: 202 }))
    await notifyEmailReminder(token, 'Qwen 4B')
    expect(browser).not.toHaveBeenCalled()
    expect(mocks.native).toHaveBeenCalledExactlyOnceWith(
      'https://api.atomic.chat/v1/reminders/notify',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model_name: 'Qwen 4B' }),
      })
    )
  })

  it('preserves rate-limit timing without exposing an echoed address or token', async () => {
    browser.mockResolvedValue(
      new Response(JSON.stringify({ email: body.email }), {
        status: 429,
        headers: { 'Retry-After': '3600' },
      })
    )
    const error = await registerEmailReminder(token, body).catch(
      (e: unknown) => e
    )
    expect(error).toBeInstanceOf(EmailReminderError)
    expect(error).toMatchObject({ status: 429, retryAfterMs: 3_600_000 })
    expect(String(error)).not.toContain(body.email)
    expect(String(error)).not.toContain(token)
  })

  it('times out even if the transport ignores abort', async () => {
    vi.useFakeTimers()
    browser.mockImplementation(() => new Promise(() => undefined))
    const result = notifyEmailReminder(token, 'Qwen 4B')
    const assertion = expect(result).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(REMINDER_TIMEOUT_MS)
    await assertion
    expect(browser.mock.calls[0][1].signal.aborted).toBe(true)
  })
})
