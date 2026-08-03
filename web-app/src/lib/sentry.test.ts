import type { ErrorEvent } from '@sentry/react'
import { describe, expect, it } from 'vitest'

import { applyKnownFingerprints, isDevelopmentOnlyEvent } from '@/lib/sentry'

const errorEvent = (
  value: string,
  frames: Array<{ filename?: string; abs_path?: string }> = []
): ErrorEvent =>
  ({
    exception: {
      values: [{ type: 'TypeError', value, stacktrace: { frames } }],
    },
  }) as unknown as ErrorEvent

describe('isDevelopmentOnlyEvent', () => {
  it('drops errors raised from the Vite dev client', () => {
    expect(
      isDevelopmentOnlyEvent(
        errorEvent('Failed to fetch dynamically imported module', [
          { filename: 'http://localhost:1420/@vite/client' },
        ])
      )
    ).toBe(true)
  })

  it('drops errors raised from the React Refresh runtime', () => {
    expect(
      isDevelopmentOnlyEvent(
        errorEvent("Cannot read properties of undefined (reading 'type')", [
          { abs_path: 'http://localhost:1420/@react-refresh' },
        ])
      )
    ).toBe(true)
  })

  it('keeps production exceptions', () => {
    expect(
      isDevelopmentOnlyEvent(
        errorEvent('Cannot read properties of undefined', [
          { filename: 'app:///assets/index-abc123.js' },
        ])
      )
    ).toBe(false)
  })
})

describe('applyKnownFingerprints', () => {
  it('groups the Tauri unlisten race into one issue', () => {
    const event = applyKnownFingerprints(
      errorEvent(
        "undefined is not an object (evaluating 'listeners[eventId].handlerId')"
      )
    )

    expect(event.fingerprint).toEqual(['tauri-unlisten-race'])
  })

  it('leaves unrelated events on default grouping', () => {
    const event = applyKnownFingerprints(errorEvent('Failed to load model'))

    expect(event.fingerprint).toBeUndefined()
  })
})
