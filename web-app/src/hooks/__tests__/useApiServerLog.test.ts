import { beforeEach, describe, expect, it } from 'vitest'

import type { ApiLogEntry, ApiRequestEntry } from '@/types/apiServerLog'

import {
  MAX_LOG_ENTRIES,
  filterEntries,
  useApiServerLog,
} from '../useApiServerLog'

function request(id: string, overrides: Partial<ApiRequestEntry> = {}): ApiRequestEntry {
  return {
    kind: 'request',
    id,
    seq: 0,
    startedAt: 1_700_000_000_000,
    status: 'in_flight',
    method: 'POST',
    endpoint: 'chat/completions',
    model: 'gemma-4',
    stream: true,
    ...overrides,
  }
}

const store = () => useApiServerLog.getState()
const entryById = (id: string) =>
  store().entries.find((e) => e.id === id) as ApiRequestEntry | undefined

describe('useApiServerLog', () => {
  beforeEach(() => {
    store().reset()
  })

  it('merges a finish patch into the matching started entry', () => {
    store().applyBatch([{ t: 'start', entry: request('a') }])
    store().applyBatch([
      { t: 'patch', id: 'a', patch: { status: 'completed', durationMs: 42 } },
    ])
    expect(entryById('a')).toMatchObject({
      status: 'completed',
      durationMs: 42,
      // The started fields survive the patch.
      endpoint: 'chat/completions',
    })
    expect(store().entries).toHaveLength(1)
  })

  it('never lets a patch overwrite a known field with undefined', () => {
    store().applyBatch([
      { t: 'start', entry: request('a', { promptPreview: 'keep me' }) },
    ])
    store().applyBatch([
      { t: 'patch', id: 'a', patch: { promptPreview: undefined, durationMs: 5 } },
    ])
    expect(entryById('a')?.promptPreview).toBe('keep me')
  })

  it('ignores a patch for an unknown id', () => {
    store().applyBatch([{ t: 'start', entry: request('a') }])
    store().applyBatch([{ t: 'patch', id: 'ghost', patch: { durationMs: 1 } }])
    expect(store().entries).toHaveLength(1)
    expect(entryById('a')?.durationMs).toBeUndefined()
  })

  it('keeps entries newest first and preserves arrival order within a batch', () => {
    store().applyBatch([
      { t: 'start', entry: request('first') },
      { t: 'start', entry: request('second') },
      { t: 'start', entry: request('third') },
    ])
    expect(store().entries.map((e) => e.id)).toEqual(['third', 'second', 'first'])
  })

  it('evicts the oldest entries past the cap', () => {
    store().applyBatch(
      Array.from({ length: MAX_LOG_ENTRIES + 10 }, (_, i) => ({
        t: 'start' as const,
        entry: request(`r${i}`),
      }))
    )
    expect(store().entries).toHaveLength(MAX_LOG_ENTRIES)
    expect(store().entries[0].id).toBe(`r${MAX_LOG_ENTRIES + 9}`)
    expect(entryById('r0')).toBeUndefined()
  })

  it('auto-selects the first arrival exactly once and never follows the head', () => {
    store().applyBatch([{ t: 'start', entry: request('a') }])
    expect(store().selectedId).toBe('a')
    store().applyBatch([{ t: 'start', entry: request('b') }])
    expect(store().selectedId).toBe('a')
  })

  it('clears the selection when the selected entry is evicted', () => {
    store().applyBatch([{ t: 'start', entry: request('a') }])
    expect(store().selectedId).toBe('a')
    store().applyBatch(
      Array.from({ length: MAX_LOG_ENTRIES }, (_, i) => ({
        t: 'start' as const,
        entry: request(`r${i}`),
      }))
    )
    expect(entryById('a')).toBeUndefined()
    expect(store().selectedId).toBeNull()
  })

  it('respects an explicit selection', () => {
    store().applyBatch([
      { t: 'start', entry: request('a') },
      { t: 'start', entry: request('b') },
    ])
    store().select('b')
    store().applyBatch([{ t: 'start', entry: request('c') }])
    expect(store().selectedId).toBe('b')
  })

  it('clear empties the log and the selection', () => {
    store().applyBatch([{ t: 'start', entry: request('a') }])
    store().clear()
    expect(store().entries).toEqual([])
    expect(store().selectedId).toBeNull()
  })

  it('hydrate replaces the log and marks the feed available', () => {
    store().setFeedUnavailable(true)
    store().hydrate([request('a'), request('b')], 3)
    expect(store().entries.map((e) => e.id)).toEqual(['a', 'b'])
    expect(store().hydrated).toBe(true)
    expect(store().feedUnavailable).toBe(false)
    expect(store().droppedEvents).toBe(3)
    expect(store().selectedId).toBe('a')
  })

  it('applyBatch on an empty op list does not touch state', () => {
    store().applyBatch([{ t: 'start', entry: request('a') }])
    const before = store().entries
    store().applyBatch([])
    expect(store().entries).toBe(before)
  })
})

describe('filterEntries', () => {
  const notice: ApiLogEntry = {
    kind: 'event',
    id: 'n',
    seq: -1,
    startedAt: 0,
    level: 'info',
    title: 'Model loaded',
    detail: 'gemma-4:Q4_K_S',
  }
  const entries: ApiLogEntry[] = [
    request('a', { status: 'completed', promptPreview: 'What is Unsloth?' }),
    request('b', { status: 'error', errorKind: 'upstream_status', model: 'llama' }),
    request('c', { status: 'in_flight' }),
    request('d', { status: 'cancelled' }),
    notice,
  ]

  it('passes everything through on the all filter', () => {
    expect(filterEntries(entries, 'all', '')).toHaveLength(5)
  })

  it('narrows to one request status and drops notices', () => {
    expect(filterEntries(entries, 'errors', '').map((e) => e.id)).toEqual(['b'])
    expect(filterEntries(entries, 'in_flight', '').map((e) => e.id)).toEqual(['c'])
    expect(filterEntries(entries, 'cancelled', '').map((e) => e.id)).toEqual(['d'])
    expect(filterEntries(entries, 'completed', '').map((e) => e.id)).toEqual(['a'])
  })

  it('searches model, endpoint, preview, error and notice text', () => {
    expect(filterEntries(entries, 'all', 'unsloth').map((e) => e.id)).toEqual(['a'])
    expect(filterEntries(entries, 'all', 'llama').map((e) => e.id)).toEqual(['b'])
    expect(filterEntries(entries, 'all', 'upstream').map((e) => e.id)).toEqual(['b'])
    expect(filterEntries(entries, 'all', 'model loaded').map((e) => e.id)).toEqual(['n'])
    expect(filterEntries(entries, 'all', 'completions')).toHaveLength(4)
  })

  it('ignores surrounding whitespace and case', () => {
    expect(filterEntries(entries, 'all', '  UNSLOTH ').map((e) => e.id)).toEqual(['a'])
  })

  it('combines filter and query', () => {
    expect(filterEntries(entries, 'errors', 'unsloth')).toEqual([])
  })
})
