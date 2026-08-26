import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    activeModels: ['gemma-4'],
  },
}))

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

vi.mock('@/utils/apiServerCapacity', () => ({
  getModelContextLength: () => 4096,
  getProviderNameForModel: () => 'llamacpp',
  getConcurrentSlots: () => 4,
}))

vi.mock('@/utils/localApiServerControl', () => ({
  getLocalApiServerUrl: () => 'http://127.0.0.1:1337/v1',
}))

vi.mock('@/containers/api/ApiSettingsPopover', () => ({
  ApiSettingsPopover: () => <button>api:actions.settings</button>,
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

import { ApiPage } from '../index'

function request(id: string, overrides: Partial<ApiRequestEntry> = {}): ApiRequestEntry {
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

describe('ApiPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetFeedBuffers()
    store().reset()
    store().hydrate([])
  })

  it('renders the header, the strip and the six stat tiles', () => {
    render(<ApiPage />)
    expect(screen.getByText('api:title')).toBeInTheDocument()
    expect(screen.getByText('http://127.0.0.1:1337/v1')).toBeInTheDocument()
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
    render(<ApiPage />)
    expect(screen.getByText('api:log.empty')).toBeInTheDocument()
    act(() => {
      store().applyBatch([{ t: 'start', entry: request('a') }])
    })
    expect(screen.queryByText('api:log.empty')).not.toBeInTheDocument()
    expect(screen.getByText('/chat/completions')).toBeInTheDocument()
  })

  it('clears the log through the feed', async () => {
    render(<ApiPage />)
    act(() => {
      store().applyBatch([{ t: 'start', entry: request('a') }])
    })
    fireEvent.click(screen.getByText('api:actions.clearLog'))
    await waitFor(() => expect(clearFeed).toHaveBeenCalled())
  })

  it('refreshes both the server status and the log', async () => {
    render(<ApiPage />)
    fireEvent.click(screen.getByText('api:actions.refresh'))
    await waitFor(() => {
      expect(control.refreshStatus).toHaveBeenCalled()
      expect(hydrateFeed).toHaveBeenCalled()
    })
  })

  it('warns when the backend has no live telemetry, without hiding the controls', () => {
    act(() => {
      store().setFeedUnavailable(true)
    })
    render(<ApiPage />)
    expect(screen.getByText('api:log.feedUnavailable')).toBeInTheDocument()
    expect(screen.getByText('api:actions.settings')).toBeInTheDocument()
  })

  it('starts and stops the server from a single header button', () => {
    control.isRunning = false
    control.status = 'stopped'
    try {
      const { unmount } = render(<ApiPage />)
      // Exactly one control for the server, and it toggles.
      const start = screen.getAllByText('api:actions.start')
      expect(start).toHaveLength(1)
      fireEvent.click(start[0])
      expect(control.toggle).toHaveBeenCalledTimes(1)
      unmount()
    } finally {
      control.isRunning = true
      control.status = 'running'
    }

    render(<ApiPage />)
    expect(screen.queryByText('api:actions.start')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('api:actions.stop'))
    expect(control.toggle).toHaveBeenCalledTimes(2)
  })
})
