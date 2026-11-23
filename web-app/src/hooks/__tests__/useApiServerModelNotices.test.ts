import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useApiServerLog } from '../useApiServerLog'
import { useServiceStore } from '../useServiceHub'
import { seedServiceHub } from '@/test/service-hub'

const { appState } = vi.hoisted(() => ({
  appState: { activeModels: [] as string[] },
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useAppState', () => ({
  useAppState: (selector: (s: typeof appState) => unknown) => selector(appState),
}))

import {
  HISTORY_COMPACTED_EVENT,
  historyCompactedNotice,
  useApiServerModelNotices,
} from '../useApiServerModelNotices'

const store = () => useApiServerLog.getState()

describe('useApiServerModelNotices', () => {
  beforeEach(() => {
    store().reset()
    appState.activeModels = []
    useServiceStore.setState({ serviceHub: null })
  })

  it('does not replay the models already loaded when the screen opens', () => {
    appState.activeModels = ['gemma-4']
    renderHook(() => useApiServerModelNotices())
    expect(store().entries).toEqual([])
  })

  it('adds a row when a model is loaded', () => {
    const { rerender } = renderHook(() => useApiServerModelNotices())
    appState.activeModels = ['gemma-4']
    rerender()
    expect(store().entries).toHaveLength(1)
    expect(store().entries[0]).toMatchObject({
      kind: 'event',
      title: 'api:notice.modelLoaded',
      detail: 'gemma-4',
    })
  })

  it('adds a row when a model is unloaded', () => {
    appState.activeModels = ['gemma-4']
    const { rerender } = renderHook(() => useApiServerModelNotices())
    appState.activeModels = []
    rerender()
    expect(store().entries[0]).toMatchObject({
      title: 'api:notice.modelUnloaded',
      detail: 'gemma-4',
    })
  })

  it('stays quiet when the model set is unchanged', () => {
    appState.activeModels = ['gemma-4']
    const { rerender } = renderHook(() => useApiServerModelNotices())
    rerender()
    expect(store().entries).toEqual([])
  })

  it('adds a row when the server compacted a client request', async () => {
    const handlers: Record<string, (event: { payload: unknown }) => void> = {}
    const unlisten = vi.fn()
    seedServiceHub({
      events: {
        emit: vi.fn(),
        listen: vi.fn(async (name: string, handler) => {
          handlers[name] = handler
          return unlisten
        }),
      } as never,
    })
    const { unmount } = renderHook(() => useApiServerModelNotices())
    await waitFor(() => expect(handlers[HISTORY_COMPACTED_EVENT]).toBeDefined())

    act(() => {
      handlers[HISTORY_COMPACTED_EVENT]({
        payload: {
          provider: 'llamacpp-upstream',
          modelId: 'gemma-4',
          summarizedMessages: 14,
          tokensBefore: 28_672,
          tokensAfter: 3_072,
          cached: false,
          source: 'api',
        },
      })
      // The app's own compactions are not requests of the log.
      handlers[HISTORY_COMPACTED_EVENT]({
        payload: {
          provider: 'llamacpp-upstream',
          modelId: 'gemma-4',
          summarizedMessages: 2,
          tokensBefore: 9000,
          tokensAfter: 2000,
          cached: false,
          source: 'control',
        },
      })
    })

    expect(store().entries).toHaveLength(1)
    expect(store().entries[0]).toMatchObject({
      kind: 'event',
      title: 'api:notice.historyCompacted',
      detail: 'gemma-4 · api:notice.historyCompactedDetail',
    })
    unmount()
    expect(unlisten).toHaveBeenCalled()
  })
})

describe('historyCompactedNotice', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    `${key} ${JSON.stringify(options ?? {})}`

  it('names the model, the messages and the tokens', () => {
    expect(
      historyCompactedNotice(
        {
          provider: 'vllm',
          modelId: 'qwen',
          summarizedMessages: 14,
          tokensBefore: 28_672,
          tokensAfter: 3_072,
          cached: true,
          source: 'api',
        },
        t,
        7
      )
    ).toMatchObject({
      id: 'notice_7_compacted_qwen',
      title: 'api:notice.historyCompacted {}',
      detail:
        'qwen · api:notice.historyCompactedDetail {"count":14,"before":"28K","after":"3K"}',
    })
  })

  it('ignores anything that is not an API compaction', () => {
    expect(historyCompactedNotice(undefined, t)).toBeUndefined()
    expect(
      historyCompactedNotice({ modelId: 'qwen', source: 'control' }, t)
    ).toBeUndefined()
  })
})
