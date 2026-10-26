import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ServiceHub } from '@/services'
import { seedServiceHub } from '@/test/service-hub'
import {
  API_SERVER_LOG_SNAPSHOT_COMMAND,
  API_SERVER_LOG_SUBSCRIBE_COMMAND,
  API_SERVER_REQUEST_FINISHED_EVENT,
  API_SERVER_REQUEST_STARTED_EVENT,
  type ApiRequestEntry,
} from '@/types/apiServerLog'

import { useApiServerLog } from '../useApiServerLog'
import {
  resetFeedBuffers,
  useApiServerLogFeed,
  useApiServerLogLive,
} from '../useApiServerLogFeed'

type Handler = (event: { payload: unknown }) => void

/** The Rust ring's record shape, as `get_api_request_log` returns it. */
function record(id: string, done: boolean) {
  return {
    id,
    seq: 0,
    started_at_ms: 1_700_000_000_000,
    endpoint: 'chat/completions',
    method: 'POST',
    model_id: 'gemma-4',
    stream: false,
    done,
    ...(done ? { finished_at_ms: 1_700_000_001_000, status: 200 } : {}),
  }
}

function setup() {
  const handlers = new Map<string, Handler>()
  const listenGate: { open?: () => void } = {}
  const listenOpen = new Promise<void>((resolve) => {
    listenGate.open = resolve
  })
  let resolveSnapshot: (value: unknown) => void = () => {}
  const invoke = vi.fn((command: string) => {
    if (command === API_SERVER_LOG_SNAPSHOT_COMMAND) {
      return new Promise((resolve) => {
        resolveSnapshot = resolve
      })
    }
    return Promise.resolve(undefined)
  })
  const listen = vi.fn(async (name: string, handler: Handler) => {
    await listenOpen
    handlers.set(name, handler)
    return () => handlers.delete(name)
  })
  seedServiceHub({
    core: { invoke } as unknown as ReturnType<ServiceHub['core']>,
    events: { listen } as unknown as ReturnType<ServiceHub['events']>,
  })
  return {
    handlers,
    invoke,
    openListeners: () => listenGate.open?.(),
    resolveSnapshot: (records: unknown[]) => resolveSnapshot({ records }),
    emit: (name: string, payload: unknown) => handlers.get(name)?.({ payload }),
  }
}

const entries = () => useApiServerLog.getState().entries as ApiRequestEntry[]

describe('useApiServerLogFeed', () => {
  beforeEach(() => {
    resetFeedBuffers()
    useApiServerLog.getState().reset()
  })

  it('shows a request that started while the snapshot was being read', async () => {
    const feed = setup()
    const { unmount } = renderHook(() => useApiServerLogFeed())
    feed.openListeners()

    await waitFor(() =>
      expect(feed.invoke).toHaveBeenCalledWith(API_SERVER_LOG_SNAPSHOT_COMMAND)
    )
    // Not in the snapshot: it started after the ring was read.
    feed.emit(API_SERVER_REQUEST_STARTED_EVENT, {
      id: 'late',
      seq: 1,
      started_at_ms: 1_700_000_002_000,
      endpoint: 'chat/completions',
      method: 'POST',
    })
    await act(async () => feed.resolveSnapshot([record('early', true)]))

    await waitFor(() =>
      expect(entries().map((entry) => entry.id)).toEqual(['late', 'early'])
    )
    expect(entries()[0].status).toBe('in_flight')
    unmount()
  })

  it('lists a request the snapshot already has once, with its latest state', async () => {
    const feed = setup()
    const { unmount } = renderHook(() => useApiServerLogFeed())
    feed.openListeners()

    await waitFor(() =>
      expect(feed.invoke).toHaveBeenCalledWith(API_SERVER_LOG_SNAPSHOT_COMMAND)
    )
    // Both events also reached the ring before it was read.
    feed.emit(API_SERVER_REQUEST_STARTED_EVENT, {
      id: 'both',
      seq: 0,
      started_at_ms: 1_700_000_000_000,
      endpoint: 'chat/completions',
      method: 'POST',
    })
    feed.emit(API_SERVER_REQUEST_FINISHED_EVENT, {
      id: 'both',
      seq: 0,
      done: true,
      finished_at_ms: 1_700_000_001_000,
      status: 200,
      duration_ms: 1000,
    })
    await act(async () => feed.resolveSnapshot([record('both', true)]))

    await waitFor(() => expect(entries()[0]?.durationMs).toBe(1000))
    expect(entries().map((entry) => [entry.id, entry.status])).toEqual([
      ['both', 'completed'],
    ])
    unmount()
  })

  it('never unsubscribes a view that had not subscribed yet', async () => {
    const feed = setup()
    const { unmount } = renderHook(() => useApiServerLogFeed())

    // Unmounted while its listeners were still being attached.
    unmount()
    feed.openListeners()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(
      feed.invoke.mock.calls.filter(
        ([command]) => command === API_SERVER_LOG_SUBSCRIBE_COMMAND
      )
    ).toEqual([])
    expect(feed.handlers.size).toBe(0)
  })
})

describe('useApiServerLogLive', () => {
  beforeEach(() => {
    resetFeedBuffers()
    useApiServerLog.getState().reset()
  })

  /** What the Rust inspector emits for a request the core served while no page watched. */
  function unwatchedRequest(feed: ReturnType<typeof setup>) {
    feed.emit(API_SERVER_REQUEST_STARTED_EVENT, {
      id: 'test-request',
      seq: 0,
      started_at_ms: 1_700_000_000_000,
      endpoint: 'chat/completions',
      method: 'POST',
      model_id: 'LiquidAI/LFM2_5-1_2B-Instruct-Q4_K_M',
      unwatched: true,
    })
    feed.emit(API_SERVER_REQUEST_FINISHED_EVENT, {
      id: 'test-request',
      seq: 0,
      done: true,
      finished_at_ms: 1_700_000_001_200,
      status: 200,
      duration_ms: 1200,
      completion_tokens: 10,
    })
  }

  it('keeps the log current while no Server page is open, so Activity lists a request before its snapshot is back', async () => {
    const feed = setup()
    const root = renderHook(() => useApiServerLogLive())
    feed.openListeners()
    await waitFor(() => expect(feed.handlers.size).toBe(3))
    // Watching is the pages' business: the root only listens.
    expect(feed.invoke).not.toHaveBeenCalled()

    // Send test request on Connections, then open Activity.
    unwatchedRequest(feed)
    await waitFor(() => expect(entries()[0]?.durationMs).toBe(1200))
    const page = renderHook(() => useApiServerLogFeed())
    await waitFor(() =>
      expect(feed.invoke).toHaveBeenCalledWith(API_SERVER_LOG_SNAPSHOT_COMMAND)
    )

    // The snapshot is still being read, and the request is already listed.
    expect(
      entries().map((entry) => [entry.id, entry.status, entry.unwatched])
    ).toEqual([['test-request', 'completed', true]])
    expect(entries()[0].completionTokens).toBe(10)
    await act(async () => feed.resolveSnapshot([record('test-request', true)]))
    expect(entries().map((entry) => entry.id)).toEqual(['test-request'])

    page.unmount()
    root.unmount()
  })

  it('shares one set of listeners, which outlives a page and goes with the last holder', async () => {
    const feed = setup()
    const root = renderHook(() => useApiServerLogLive())
    feed.openListeners()
    const page = renderHook(() => useApiServerLogFeed())
    await waitFor(() =>
      expect(feed.invoke).toHaveBeenCalledWith(API_SERVER_LOG_SNAPSHOT_COMMAND)
    )
    await act(async () => feed.resolveSnapshot([]))
    expect(feed.handlers.size).toBe(3)
    expect(
      feed.invoke.mock.calls.filter(
        ([command]) => command === API_SERVER_LOG_SNAPSHOT_COMMAND
      )
    ).toHaveLength(1)

    page.unmount()
    expect(feed.handlers.size).toBe(3)
    unwatchedRequest(feed)
    await waitFor(() => expect(entries()).toHaveLength(1))

    root.unmount()
    expect(feed.handlers.size).toBe(0)
  })
})
