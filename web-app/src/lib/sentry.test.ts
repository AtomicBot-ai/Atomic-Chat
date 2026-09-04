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

const loadFailureEvent = (
  tags: Record<string, string>,
  value: string
): ErrorEvent =>
  ({
    tags,
    exception: { values: [{ type: 'Error', value }] },
  }) as unknown as ErrorEvent

describe('applyKnownFingerprints — model failures', () => {
  const oomValue = [
    'Out of memory. The model requires more RAM or VRAM than available.',
    "0.00.248.636 I srv init: Use --ui/--no-ui to enable/disable",
    "0.05.991.348 E ggml_backend_cuda_buffer_type_alloc_buffer: cudaMalloc failed",
  ].join('\n')

  it('groups a load failure by its classified cause, not the pasted log', () => {
    const a = applyKnownFingerprints(
      loadFailureEvent(
        { feature: 'model_load', error_code: 'OUT_OF_MEMORY' },
        oomValue
      )
    )
    const b = applyKnownFingerprints(
      loadFailureEvent(
        { feature: 'model_load', error_code: 'OUT_OF_MEMORY' },
        'Out of memory. The model requires more RAM or VRAM than available.\nan entirely different log'
      )
    )

    expect(a.fingerprint).toEqual(['model-load-failure', 'OUT_OF_MEMORY'])
    expect(a.fingerprint).toEqual(b.fingerprint)
  })

  it('trims the engine log out of the issue title', () => {
    const event = applyKnownFingerprints(
      loadFailureEvent(
        { feature: 'model_load', error_code: 'OUT_OF_MEMORY' },
        oomValue
      )
    )

    expect(event.exception?.values?.[0].value).toBe(
      'Out of memory. The model requires more RAM or VRAM than available.'
    )
  })

  it('records an environment cause as a warning', () => {
    const event = applyKnownFingerprints(
      loadFailureEvent(
        { feature: 'model_load', error_code: 'OUT_OF_MEMORY' },
        oomValue
      )
    )

    expect(event.level).toBe('warning')
  })

  it('leaves a genuine engine crash at its original level', () => {
    const event = applyKnownFingerprints(
      loadFailureEvent(
        { feature: 'model_load', error_code: 'LLAMA_CPP_PROCESS_ERROR' },
        'The model process crashed unexpectedly (access violation / segfault).'
      )
    )

    expect(event.fingerprint).toEqual([
      'model-load-failure',
      'LLAMA_CPP_PROCESS_ERROR',
    ])
    expect(event.level).toBeUndefined()
  })

  it('groups downloads by their failure reason', () => {
    const event = applyKnownFingerprints(
      loadFailureEvent(
        { feature: 'model_download', failure_reason: 'http_error' },
        'Failed to download: HTTP status 403 Forbidden'
      )
    )

    expect(event.fingerprint).toEqual(['model-download-failure', 'http_error'])
  })

  it('falls back to UNCLASSIFIED when the cause is missing', () => {
    const event = applyKnownFingerprints(
      loadFailureEvent({ feature: 'model_load' }, 'something went wrong')
    )

    expect(event.fingerprint).toEqual(['model-load-failure', 'UNCLASSIFIED'])
  })

  it('leaves unrelated events alone', () => {
    const event = applyKnownFingerprints(errorEvent('Cannot read properties'))

    expect(event.fingerprint).toBeUndefined()
  })
})
