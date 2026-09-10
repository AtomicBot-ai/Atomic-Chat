import { describe, expect, it } from 'vitest'

import {
  PREVIEW_MAX_CHARS,
  endpointLabel,
  endpointPath,
  normalizeFinishedPatch,
  normalizeProgressPatch,
  normalizeRecord,
  normalizeSnapshot,
  normalizeStarted,
  truncatePreview,
} from '../apiServerLogNormalize'

const started = {
  id: 'apireq_abc',
  seq: 3,
  started_at_ms: 1_700_000_000_000,
  endpoint: 'chat/completions',
  method: 'post',
  model_id: 'gemma-4',
  stream: true,
  message_count: 2,
  prompt_preview: 'What is Unsloth?',
  prompt_chars: 16,
  has_non_text_parts: false,
}

describe('normalizeStarted', () => {
  it('maps a snake_case payload', () => {
    expect(normalizeStarted(started)).toEqual({
      kind: 'request',
      id: 'apireq_abc',
      seq: 3,
      startedAt: 1_700_000_000_000,
      status: 'in_flight',
      method: 'POST',
      endpoint: 'chat/completions',
      model: 'gemma-4',
      stream: true,
      messageCount: 2,
      promptPreview: 'What is Unsloth?',
      promptChars: 16,
      hasNonTextParts: false,
    })
  })

  it('accepts camelCase spellings too', () => {
    const entry = normalizeStarted({
      id: 'x',
      startedAtMs: 42,
      modelId: 'm',
      messageCount: 1,
      promptPreview: 'hi',
    })
    expect(entry?.startedAt).toBe(42)
    expect(entry?.model).toBe('m')
    expect(entry?.promptPreview).toBe('hi')
  })

  it('returns null without an id', () => {
    expect(normalizeStarted({ endpoint: 'models' })).toBeNull()
    expect(normalizeStarted(null)).toBeNull()
    expect(normalizeStarted(['nope'])).toBeNull()
  })

  it('truncates an over-long preview', () => {
    const long = 'a'.repeat(PREVIEW_MAX_CHARS + 20)
    const entry = normalizeStarted({ id: 'x', prompt_preview: long })
    expect(entry?.promptPreview).toHaveLength(PREVIEW_MAX_CHARS + 1)
    expect(entry?.promptPreview?.endsWith('…')).toBe(true)
    expect(truncatePreview('short')).toBe('short')
    expect(truncatePreview(undefined)).toBeUndefined()
  })
})

describe('normalizeFinishedPatch', () => {
  it('derives completed from a 2xx status', () => {
    const result = normalizeFinishedPatch({
      id: 'a',
      status: 200,
      duration_ms: 3500,
      ttft_ms: 755,
      prompt_tokens: 28,
      completion_tokens: 150,
      total_tokens: 178,
      finish_reason: 'length',
      reply_preview: 'Hello!',
    })
    expect(result?.id).toBe('a')
    expect(result?.patch).toMatchObject({
      status: 'completed',
      httpStatus: 200,
      durationMs: 3500,
      ttftMs: 755,
      promptTokens: 28,
      completionTokens: 150,
      totalTokens: 178,
      finishReason: 'length',
      replyPreview: 'Hello!',
    })
  })

  it('derives error from a 4xx/5xx status or an error_kind', () => {
    expect(normalizeFinishedPatch({ id: 'a', status: 404 })?.patch.status).toBe(
      'error'
    )
    expect(
      normalizeFinishedPatch({ id: 'a', status: 200, error_kind: 'upstream' })
        ?.patch.status
    ).toBe('error')
  })

  it('derives cancelled from the aborted flag', () => {
    expect(
      normalizeFinishedPatch({ id: 'a', status: 200, aborted: true })?.patch
        .status
    ).toBe('cancelled')
  })

  it('stays in flight when no status is reported', () => {
    expect(normalizeFinishedPatch({ id: 'a' })?.patch.status).toBe('in_flight')
  })
})

describe('normalizeProgressPatch', () => {
  it('maps the running counters onto a patch', () => {
    expect(
      normalizeProgressPatch({
        id: 'a',
        ttft_ms: 100,
        completion_tokens: 12,
        reply_chars: 40,
        elapsed_ms: 900,
      })?.patch
    ).toEqual({
      ttftMs: 100,
      completionTokens: 12,
      replyChars: 40,
      durationMs: 900,
    })
  })
})

describe('normalizeRecord / normalizeSnapshot', () => {
  it('merges finished fields for a done record', () => {
    const entry = normalizeRecord({ ...started, done: true, status: 200, duration_ms: 12 })
    expect(entry?.status).toBe('completed')
    expect(entry?.durationMs).toBe(12)
    expect(entry?.promptPreview).toBe('What is Unsloth?')
  })

  it('leaves an unfinished record in flight', () => {
    expect(normalizeRecord({ ...started, done: false })?.status).toBe('in_flight')
  })

  it('reverses the oldest-first snapshot into newest-first', () => {
    const snapshot = normalizeSnapshot({
      in_flight: 1,
      dropped_events: 4,
      records: [
        { ...started, id: 'old', seq: 1 },
        { ...started, id: 'new', seq: 2 },
      ],
    })
    expect(snapshot.entries.map((e) => e.id)).toEqual(['new', 'old'])
    expect(snapshot.inFlight).toBe(1)
    expect(snapshot.droppedEvents).toBe(4)
  })

  it('tolerates a missing or malformed snapshot', () => {
    expect(normalizeSnapshot(undefined).entries).toEqual([])
    expect(normalizeSnapshot({ records: 'nope' }).entries).toEqual([])
  })
})

describe('endpoint formatting', () => {
  it('composes the full path with the configured prefix', () => {
    expect(endpointPath('chat/completions')).toBe('/v1/chat/completions')
    expect(endpointPath('chat/completions', 'api')).toBe('/api/chat/completions')
    expect(endpointPath('models', '/v1/')).toBe('/v1/models')
  })

  it('labels endpoints with a leading slash, except the catch-all', () => {
    expect(endpointLabel('chat/completions')).toBe('/chat/completions')
    expect(endpointLabel('other')).toBe('other')
  })
})
