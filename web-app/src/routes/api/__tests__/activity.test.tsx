import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { useApiServerLog } from '@/hooks/useApiServerLog'
import type { ApiRequestEntry } from '@/types/apiServerLog'

const { control, clearFeed, hydrateFeed, appState } = vi.hoisted(() => ({
  control: {
    status: 'running' as 'running' | 'stopped' | 'pending',
    isRunning: true,
    isModelLoading: false,
    isBusy: false,
    start: vi.fn(),
    stop: vi.fn(),
    toggle: vi.fn(),
    refreshStatus: vi.fn().mockResolvedValue(undefined),
  },
  clearFeed: vi.fn().mockResolvedValue(undefined),
  hydrateFeed: vi.fn().mockResolvedValue(undefined),
  appState: {
    serverStatus: 'running' as const,
    activeModels: ['gemma-4'] as string[],
  },
}))

// Whether the page is too narrow for the list and the details side by side.
const layout = vi.hoisted(() => ({ stacked: false }))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useLocalApiServerControl', () => ({
  useLocalApiServerControl: () => control,
}))

vi.mock('@/hooks/useApiServerLogFeed', async () => {
  const actual = await vi.importActual<
    typeof import('@/hooks/useApiServerLogFeed')
  >('@/hooks/useApiServerLogFeed')
  return {
    ...actual,
    useApiServerLogFeed: () => ({ clear: clearFeed, hydrate: hydrateFeed }),
  }
})

vi.mock('@/hooks/useAppState', () => ({
  useAppState: Object.assign(
    (selector?: (s: typeof appState) => unknown) =>
      selector ? selector(appState) : appState,
    { getState: () => appState }
  ),
}))

vi.mock('@/hooks/useStackedListDetail', () => ({
  useStackedListDetail: () => ({
    ref: { current: null },
    stacked: layout.stacked,
  }),
}))

vi.mock('@/utils/apiServerCapacity', () => ({
  getModelContextLength: () => 4096,
}))

vi.mock('@/utils/localApiServerControl', () => ({
  getLocalApiServerUrl: () => 'http://127.0.0.1:1337/v1',
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 64,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 64,
        size: 64,
      })),
    measureElement: () => {},
  }),
}))

import { resetFeedBuffers } from '@/hooks/useApiServerLogFeed'

import { ApiActivityPage } from '../activity'

function request(
  id: string,
  overrides: Partial<ApiRequestEntry> = {}
): ApiRequestEntry {
  return {
    kind: 'request',
    id,
    seq: 0,
    startedAt: Date.now(),
    status: 'completed',
    method: 'POST',
    endpoint: 'chat/completions',
    model: 'gemma-4',
    stream: true,
    durationMs: 1000,
    ...overrides,
  }
}

const store = () => useApiServerLog.getState()

describe('Server → Activity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetFeedBuffers()
    store().reset()
    store().hydrate([])
    appState.activeModels = ['gemma-4']
    layout.stacked = false
  })

  it('renders the title, the actions and the six stat tiles', () => {
    render(<ApiActivityPage />)
    expect(
      screen.getByRole('heading', { name: 'api:activity.title' })
    ).toBeInTheDocument()
    expect(screen.getByText('api:actions.refresh')).toBeInTheDocument()
    expect(screen.getByText('api:actions.clearLog')).toBeInTheDocument()
    for (const key of [
      'api:stats.inFlight',
      'api:stats.requests',
      'api:stats.completed',
      'api:stats.errors',
      'api:stats.avgLatency',
      'api:stats.throughput',
    ]) {
      expect(screen.getByText(key)).toBeInTheDocument()
    }
  })

  it('shows the empty state until traffic arrives', () => {
    render(<ApiActivityPage />)
    expect(screen.getByText('api:log.empty')).toBeInTheDocument()
    act(() => {
      store().applyBatch([{ t: 'start', entry: request('a') }])
    })
    expect(screen.queryByText('api:log.empty')).not.toBeInTheDocument()
    expect(screen.getByText('/chat/completions')).toBeInTheDocument()
  })

  it('clears the log through the feed', async () => {
    // As the real feed does: the core's log and the store empty together.
    clearFeed.mockImplementationOnce(async () => {
      store().reset()
      store().hydrate([])
    })
    render(<ApiActivityPage />)
    act(() => {
      store().applyBatch([{ t: 'start', entry: request('a') }])
    })
    expect(screen.getByText('/chat/completions')).toBeInTheDocument()

    fireEvent.click(screen.getByText('api:actions.clearLog'))

    await waitFor(() =>
      expect(screen.getByText('api:log.empty')).toBeInTheDocument()
    )
    expect(screen.queryByText('/chat/completions')).not.toBeInTheDocument()
    expect(clearFeed).toHaveBeenCalledTimes(1)
  })

  it('refreshes both the server status and the log', async () => {
    let finishStatus = () => {}
    control.refreshStatus.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishStatus = resolve))
    )
    render(<ApiActivityPage />)
    const refresh = screen.getByText('api:actions.refresh')
    const icon = () => refresh.closest('button')!.querySelector('svg')!

    fireEvent.click(refresh)

    await waitFor(() => {
      expect(control.refreshStatus).toHaveBeenCalled()
      expect(hydrateFeed).toHaveBeenCalled()
    })
    // The icon spins until both have answered.
    expect(icon()).toHaveClass('animate-spin')
    await act(async () => finishStatus())
    expect(icon()).not.toHaveClass('animate-spin')
  })

  it('warns when the backend has no live telemetry, without hiding the controls', () => {
    act(() => {
      store().setFeedUnavailable(true)
    })
    render(<ApiActivityPage />)
    expect(screen.getByText('api:log.feedUnavailable')).toBeInTheDocument()
    expect(screen.getByText('api:actions.refresh')).toBeInTheDocument()
  })

  it('holds the details column beside the list when the page is wide', () => {
    render(<ApiActivityPage />)
    expect(screen.getByText('api:detail.selectPrompt')).toBeInTheDocument()
  })

  it('keeps no empty details pane under the list on a narrow page', () => {
    layout.stacked = true
    render(<ApiActivityPage />)
    expect(screen.getByText('api:log.empty')).toBeInTheDocument()
    expect(
      screen.queryByText('api:detail.selectPrompt')
    ).not.toBeInTheDocument()
  })

  it('opens a request picked on a narrow page under the list, in view', async () => {
    layout.stacked = true
    // jsdom lays nothing out, so it has no scrollIntoView of its own.
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    onTestFinished(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    })
    render(<ApiActivityPage />)
    act(() => {
      store().applyBatch([
        { t: 'start', entry: request('a', { endpoint: 'models' }) },
        { t: 'start', entry: request('b') },
      ])
    })

    fireEvent.click(screen.getByText('/models'))

    expect(store().selectedId).toBe('a')
    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    )
    // The details of the picked request sit after the list, full width.
    const details = scrollIntoView.mock.contexts[0] as HTMLElement
    expect(details).toHaveTextContent('/models')
  })
})
