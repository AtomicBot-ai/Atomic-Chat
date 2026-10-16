import { beforeEach, describe, expect, it, vi } from 'vitest'

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
}))
vi.mock('@sentry/react', () => sentry)

import type { ErrorEvent } from '@sentry/react'
import {
  CRASH_REPORTING_STORAGE_KEY,
  initCrashReporting,
  migrateLegacyConsent,
  reportError,
  scrubBreadcrumb,
  scrubEvent,
  scrubText,
  useCrashReporting,
} from '../crash-reporting'

describe('consent', () => {
  beforeEach(() => {
    localStorage.clear()
    useCrashReporting.setState({ enabled: false })
  })

  it('is off by default', () => {
    expect(useCrashReporting.getState().enabled).toBe(false)
  })

  it('discards the consent inherited from upstream', () => {
    localStorage.setItem(
      'productAnalytic',
      '{"state":{"productAnalytic":true}}'
    )
    localStorage.setItem('productAnalyticPrompt', '{"state":{}}')
    migrateLegacyConsent()
    expect(localStorage.getItem('productAnalytic')).toBeNull()
    expect(localStorage.getItem('productAnalyticPrompt')).toBeNull()
    expect(useCrashReporting.getState().enabled).toBe(false)
  })

  it('resets a pre-versioned persisted "on" to off', async () => {
    localStorage.setItem(
      CRASH_REPORTING_STORAGE_KEY,
      JSON.stringify({ state: { enabled: true }, version: 0 })
    )
    await useCrashReporting.persist.rehydrate()
    expect(useCrashReporting.getState().enabled).toBe(false)
  })

  it('keeps the user’s own choice across launches', async () => {
    useCrashReporting.getState().setEnabled(true)
    const stored = JSON.parse(
      localStorage.getItem(CRASH_REPORTING_STORAGE_KEY)!
    )
    expect(stored).toEqual({ state: { enabled: true }, version: 1 })
    await useCrashReporting.persist.rehydrate()
    expect(useCrashReporting.getState().enabled).toBe(true)
  })
})

describe('initialisation', () => {
  beforeEach(() => {
    sentry.init.mockClear()
    sentry.captureException.mockClear()
  })

  it('is fully inert without a DSN', () => {
    expect(initCrashReporting('')).toBe(false)
    expect(sentry.init).not.toHaveBeenCalled()
    useCrashReporting.setState({ enabled: true })
    reportError(new Error('x'))
    expect(sentry.captureException).not.toHaveBeenCalled()
  })

  it('with a DSN, sends only after consent and always scrubbed', () => {
    expect(initCrashReporting('https://public@o1.ingest.sentry.io/1')).toBe(
      true
    )
    const opts = sentry.init.mock.calls[0][0]
    expect(opts.sendDefaultPii).toBe(false)
    expect(opts.tracesSampleRate).toBe(0)

    const event = {
      message: 'failed for /Users/warwick/models/a.gguf',
      user: { id: 'u' },
    } as unknown as ErrorEvent
    useCrashReporting.setState({ enabled: false })
    expect(opts.beforeSend(event)).toBeNull()
    expect(opts.beforeBreadcrumb({ category: 'navigation' })).toBeNull()
    reportError(new Error('x'))
    expect(sentry.captureException).not.toHaveBeenCalled()

    useCrashReporting.setState({ enabled: true })
    const sent = opts.beforeSend(event)
    expect(sent.user).toBeUndefined()
    expect(sent.message).toBe('failed for /Users/~/models/a.gguf')
    reportError(new Error('x'))
    expect(sentry.captureException).toHaveBeenCalledTimes(1)
  })
})

describe('scrubbing', () => {
  it.each([
    ['/home/alice/.config/x', '/home/~/.config/x'],
    ['C:\\Users\\Bob\\AppData\\x', 'C:\\Users\\~\\AppData\\x'],
    ['key sk-proj-abcdefghijklmnop', 'key <redacted>'],
    ['hf_abcdefghijklmnopqrstu', '<redacted>'],
    ['Authorization: Bearer abc.def', 'Authorization: Bearer <redacted>'],
    ['api_key=supersecret&x=1', 'api_key=<redacted>&x=1'],
    ['mail me at a.b@example.com', 'mail me at <email>'],
    ['https://user:pw@host/x', 'https://host/x'],
  ])('%s', (input, expected) => {
    expect(scrubText(input)).toBe(expected)
  })

  it('drops request bodies, query strings, prompts and user', () => {
    const out = scrubEvent({
      user: { email: 'x@y.z' },
      server_name: 'warwicks-pc',
      request: {
        url: 'http://127.0.0.1:1337/v1/chat?key=abc',
        data: '{"messages":[{"content":"my secret plan"}]}',
        headers: { Authorization: 'Bearer x' },
      },
      extra: {
        prompt: 'my secret plan',
        messages: [{ content: 'hi' }],
        model: 'qwen',
      },
      contexts: { state: { content: 'chat text', count: 2 } },
    } as unknown as ErrorEvent)
    expect(out.user).toBeUndefined()
    expect(out.server_name).toBeUndefined()
    expect(out.request).toEqual({ url: 'http://127.0.0.1:1337/v1/chat' })
    expect(out.extra).toEqual({
      prompt: '<redacted>',
      messages: '<redacted>',
      model: 'qwen',
    })
    expect(JSON.stringify(out)).not.toContain('secret plan')
    expect(JSON.stringify(out)).not.toContain('chat text')
  })

  it('scrubs exception values and stack paths, and drops frame vars', () => {
    const out = scrubEvent({
      exception: {
        values: [
          {
            value: 'ENOENT /Users/warwick/x',
            stacktrace: {
              frames: [
                {
                  filename: '/home/warwick/app.js',
                  vars: { prompt: 'hello' },
                },
              ],
            },
          },
        ],
      },
    } as unknown as ErrorEvent)
    const ex = out.exception!.values![0]
    expect(ex.value).toBe('ENOENT /Users/~/x')
    expect(ex.stacktrace!.frames![0].filename).toBe('/home/~/app.js')
    expect(ex.stacktrace!.frames![0].vars).toBeUndefined()
  })

  it('keeps only breadcrumbs that cannot carry typed text', () => {
    expect(
      scrubBreadcrumb({ category: 'console', message: 'prompt: hi' })
    ).toBeNull()
    expect(
      scrubBreadcrumb({ category: 'fetch', data: { url: 'x' } })
    ).toBeNull()
    expect(scrubBreadcrumb({ category: 'ui.input' })).toBeNull()
    expect(
      scrubBreadcrumb({ category: 'navigation', data: { to: '/threads/1' } })
    ).toMatchObject({ category: 'navigation' })
  })
})
