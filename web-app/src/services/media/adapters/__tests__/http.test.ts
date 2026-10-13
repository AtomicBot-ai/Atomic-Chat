import { describe, expect, it } from 'vitest'

import {
  blobFromDataUrl,
  codeForStatus,
  describeFailure,
  isRetryableStatus,
  redactCredentials,
  retryAfterMs,
  sameOrigin,
  signalWithDeadline,
} from '../http'

describe('signalWithDeadline', () => {
  it("keeps the caller's signal so cancelling still works", () => {
    const controller = new AbortController()
    expect(signalWithDeadline(controller.signal, 10)).toBe(controller.signal)
  })

  it('adds a deadline when the caller passed none', async () => {
    const signal = signalWithDeadline(undefined, 5)
    expect(signal).toBeDefined()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(signal?.aborted).toBe(true)
    expect(describeFailure(signal?.reason)).toBe('The request timed out.')
  })
})

describe('retryAfterMs', () => {
  it('reads delta-seconds', () => {
    expect(retryAfterMs('7')).toBe(7000)
  })

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('Fri, 09 Oct 2026 12:00:00 GMT')
    expect(retryAfterMs('Fri, 09 Oct 2026 12:00:30 GMT', now)).toBe(30_000)
    expect(retryAfterMs('Fri, 09 Oct 2026 11:00:00 GMT', now)).toBe(0)
  })

  it('ignores a missing or unreadable header', () => {
    expect(retryAfterMs(null)).toBeUndefined()
    expect(retryAfterMs('soon')).toBeUndefined()
  })
})

describe('status mapping', () => {
  it.each([
    [401, 'unauthorised', false],
    [402, 'insufficient_credit', false],
    [404, 'not_found', false],
    [408, 'timeout', true],
    [413, 'payload_too_large', false],
    [422, 'invalid_request', false],
    [429, 'rate_limited', true],
    [503, 'provider_unavailable', true],
  ])('%i is %s (retryable: %s)', (status, code, retryable) => {
    expect(codeForStatus(status)).toBe(code)
    expect(isRetryableStatus(status)).toBe(retryable)
  })
})

describe('redactCredentials', () => {
  it('removes a bearer token echoed by the provider', () => {
    const text = 'Incorrect API key provided: sk-secret-123.'
    expect(
      redactCredentials(text, { Authorization: 'Bearer sk-secret-123' })
    ).toBe('Incorrect API key provided: [redacted].')
  })

  it('removes the encoded, decoded and password forms of Basic auth', () => {
    const token = btoa('radium:hunter22')
    const text = `sent ${token}, user radium:hunter22, password hunter22`
    const redacted = redactCredentials(text, {
      Authorization: `Basic ${token}`,
    })
    expect(redacted).not.toContain(token)
    expect(redacted).not.toContain('hunter22')
  })

  it('leaves text alone when no credential was sent', () => {
    expect(redactCredentials('plain', undefined)).toBe('plain')
    expect(redactCredentials('plain', {})).toBe('plain')
  })
})

describe('sameOrigin', () => {
  it('only accepts URLs on the configured origin', () => {
    const base = 'https://queue.fal.run'
    expect(sameOrigin('https://queue.fal.run/fal-ai/x/requests/1', base)).toBe(
      true
    )
    expect(sameOrigin('https://evil.example/fal-ai/x', base)).toBe(false)
    expect(sameOrigin('not a url', base)).toBe(false)
  })
})

describe('blobFromDataUrl', () => {
  it('decodes base64 data URLs with their MIME type', () => {
    const blob = blobFromDataUrl('data:image/png;base64,' + btoa('png!'))
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(4)
  })
})
