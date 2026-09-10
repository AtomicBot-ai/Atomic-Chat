import { describe, it, expect, beforeEach, vi } from 'vitest'

import { localStorageKey } from '@/constants/localStorage'
import { defaultAssistant, useAssistant } from '@/hooks/useAssistant'
import { useThreads } from '@/hooks/useThreads'
import {
  getSamplingParamsForThread,
  migrateGlobalSamplingToAssistants,
  resolveAssistantForThread,
} from '../samplingParams'

vi.mock('fzf', () => ({
  Fzf: vi.fn(() => ({ find: vi.fn(() => []) })),
}))

const makeAssistant = (
  id: string,
  parameters: Record<string, unknown>,
  overridden?: boolean
): Assistant => ({
  id,
  name: id,
  instructions: '',
  created_at: 1,
  parameters,
  sampling_overridden: overridden,
})

const bindThread = (threadId: string, assistantId?: string) => {
  useThreads.setState({
    threads: {
      [threadId]: {
        id: threadId,
        title: threadId,
        updated: 1,
        assistants: assistantId
          ? [{ id: assistantId, name: assistantId, instructions: '' }]
          : [],
      } as unknown as Thread,
    },
  })
}

describe('resolveAssistantForThread', () => {
  const bound = makeAssistant('bound', { temperature: 0.1 }, true)
  const pending = makeAssistant('pending', { temperature: 0.2 })
  const fallback = makeAssistant('fallback', { temperature: 0.3 })

  beforeEach(() => {
    useThreads.setState({ threads: {}, currentThreadId: undefined })
    useAssistant.setState({
      assistants: [bound, pending, fallback],
      pendingAssistant: undefined,
      defaultAssistantId: 'fallback',
    })
  })

  it('prefers the assistant bound to the thread', () => {
    bindThread('thread-1', 'bound')
    useAssistant.setState({ pendingAssistant: pending })

    expect(resolveAssistantForThread('thread-1')?.id).toBe('bound')
  })

  it('falls back to the unsaved-chat selection when no thread is bound', () => {
    useAssistant.setState({ pendingAssistant: pending })

    expect(resolveAssistantForThread(undefined)?.id).toBe('pending')
  })

  it('reads the live record, not the stale selection copy', () => {
    useAssistant.setState({
      pendingAssistant: makeAssistant('pending', { temperature: 0.9 }),
    })

    expect(resolveAssistantForThread(undefined)?.parameters.temperature).toBe(
      0.2
    )
  })

  it('falls back to the default assistant for an unknown thread', () => {
    expect(resolveAssistantForThread('missing-thread')?.id).toBe('fallback')
  })

  it('falls back to the first assistant when no default matches', () => {
    useAssistant.setState({ defaultAssistantId: 'deleted' })

    expect(resolveAssistantForThread(undefined)?.id).toBe('bound')
  })
})

describe('getSamplingParamsForThread', () => {
  beforeEach(() => {
    useThreads.setState({ threads: {}, currentThreadId: undefined })
  })

  it('returns the bound assistant params and override flag', () => {
    const tuned = makeAssistant('tuned', { temperature: 0.42 }, true)
    useAssistant.setState({
      assistants: [tuned],
      pendingAssistant: undefined,
      defaultAssistantId: 'tuned',
    })
    bindThread('thread-1', 'tuned')

    expect(getSamplingParamsForThread('thread-1')).toEqual({
      params: { temperature: 0.42 },
      overridden: true,
      assistantId: 'tuned',
    })
  })

  it('falls back to the built-in defaults when there is no assistant', () => {
    useAssistant.setState({ assistants: [], pendingAssistant: undefined })

    expect(getSamplingParamsForThread('thread-1')).toEqual({
      params: { ...defaultAssistant.parameters },
      overridden: false,
    })
  })
})

describe('migrateGlobalSamplingToAssistants', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  const storeGlobal = (
    params: Record<string, unknown>,
    userOverridden = false
  ) =>
    localStorage.setItem(
      localStorageKey.samplingSettings,
      JSON.stringify({ state: { params, userOverridden }, version: 0 })
    )

  it('seeds assistants that carry no sampling of their own', () => {
    storeGlobal({ temperature: 0.55, top_k: 30 }, true)

    const result = migrateGlobalSamplingToAssistants([
      makeAssistant('empty', {}),
      makeAssistant('tuned', { temperature: 0.1 }),
    ])

    expect(result.assistants[0].parameters).toEqual({
      temperature: 0.55,
      top_k: 30,
    })
    expect(result.assistants[0].sampling_overridden).toBe(true)
    expect(result.assistants[1].parameters).toEqual({ temperature: 0.1 })
    expect(result.changed.map((a) => a.id)).toEqual(['empty'])
    expect(
      localStorage.getItem(localStorageKey.samplingMigratedPerAssistant)
    ).toBe('true')
  })

  it('runs only once', () => {
    storeGlobal({ temperature: 0.55 })
    migrateGlobalSamplingToAssistants([makeAssistant('empty', {})])

    const second = migrateGlobalSamplingToAssistants([
      makeAssistant('empty', {}),
    ])

    expect(second.changed).toEqual([])
    expect(second.assistants[0].parameters).toEqual({})
  })

  it('marks itself done when there is nothing stored', () => {
    const result = migrateGlobalSamplingToAssistants([
      makeAssistant('empty', {}),
    ])

    expect(result.changed).toEqual([])
    expect(
      localStorage.getItem(localStorageKey.samplingMigratedPerAssistant)
    ).toBe('true')
  })
})
