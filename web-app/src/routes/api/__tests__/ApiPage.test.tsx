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
    activeModels: ['gemma-4'] as string[],
  },
}))

vi.mock('@/lib/decision/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/decision/models')>()),
  isDecisionModelInstalled: vi.fn().mockResolvedValue(false),
}))

vi.mock('@/services/decision-catalog-registry', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/services/decision-catalog-registry')
    >()
  return {
    ...actual,
    fetchDecisionCatalog: vi.fn(async () => ({
      catalog: actual.getBaselineDecisionCatalog(),
      source: 'baseline',
    })),
  }
})

vi.mock('@/lib/embedding/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/embedding/models')>()),
  isEmbeddingModelInstalled: vi.fn().mockResolvedValue(false),
}))

vi.mock('@/services/embedding-catalog-registry', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/services/embedding-catalog-registry')
    >()
  return {
    ...actual,
    fetchEmbeddingCatalog: vi.fn(async () => ({
      catalog: actual.getBaselineEmbeddingCatalog(),
      source: 'baseline',
    })),
  }
})

const copied = vi.hoisted(() => vi.fn())
vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: async (text: string) => {
    copied(text)
    return true
  },
}))

const { features, sectionServer } = vi.hoisted(() => ({
  features: { localApiServer: true } as Record<string, boolean>,
  sectionServer: vi.fn(),
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
}))

vi.mock('@/utils/localApiServerControl', () => ({
  getLocalApiServerUrl: () => 'http://127.0.0.1:1337/v1',
}))

vi.mock('@/containers/api/ApiSettingsPopover', () => ({
  ApiSettingsPopover: () => <button>api:actions.settings</button>,
}))

vi.mock('@/lib/platform/const', () => ({ PlatformFeatures: features }))

vi.mock('@/containers/remote-lan/RemoteLanSection', () => ({
  RemoteLanSection: ({ server }: { server: unknown }) => {
    sectionServer(server)
    return <section aria-label="remote-lan" />
  },
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
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
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import type { DecisionService, DecisionState } from '@/services/decision/types'
import type {
  EmbeddingService,
  EmbeddingStatus,
} from '@/services/embedding/types'
import { useDecisionStore } from '@/stores/decision-store'
import { useEmbeddingStore } from '@/stores/embedding-store'
import { seedServiceHub } from '@/test/service-hub'

import { ApiPage } from '../index'

const getDecisionConfig = vi.fn()
const initialDecision = useDecisionStore.getState()

function decisionAs(state: DecisionState, enabled = state !== 'disabled') {
  getDecisionConfig.mockResolvedValue({
    config: { enabled, model_id: 'laya-multilingual' },
    status: {
      state,
      enabled,
      model_path: '/data/decision/models/laya-multilingual',
      error: null,
    },
  })
}

const getEmbeddingConfig = vi.fn()
const initialEmbedding = useEmbeddingStore.getState()

function embeddingAs(
  state: EmbeddingStatus['state'],
  status: Partial<EmbeddingStatus> = {}
) {
  const enabled = state !== 'disabled'
  getEmbeddingConfig.mockResolvedValue({
    config: { enabled, model_id: status.model_id ?? 'bge-m3' },
    status: {
      state,
      enabled,
      model_id: 'bge-m3',
      modalities: [],
      error: null,
      ...status,
    },
  })
  seedServiceHub({
    decision: {
      isSupported: () => true,
      getConfig: getDecisionConfig,
      subscribe: () => () => {},
    } as unknown as DecisionService,
    embedding: {
      isSupported: () => true,
      getConfig: getEmbeddingConfig,
      subscribe: () => () => {},
    } as unknown as EmbeddingService,
  })
}

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

describe('ApiPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetFeedBuffers()
    store().reset()
    store().hydrate([])
    features.localApiServer = true
    appState.activeModels = ['gemma-4']
    useDecisionStore.setState(initialDecision, true)
    useEmbeddingStore.setState(initialEmbedding, true)
    useLocalApiServer.getState().setApiKey('')
    decisionAs('disabled')
    seedServiceHub({
      decision: {
        isSupported: () => true,
        getConfig: getDecisionConfig,
        subscribe: () => () => {},
      } as unknown as DecisionService,
    })
  })

  it('names the decision model the server answers /systemone with', async () => {
    decisionAs('ready')
    render(<ApiPage />)
    expect(await screen.findByText('Laya Multilingual')).toBeInTheDocument()
    expect(screen.getByText('api:strip.decisionModel')).toBeInTheDocument()
    expect(screen.getByText('gemma-4')).toBeInTheDocument()
  })

  it('reads Ready from a decision model alone, and marks one still starting', async () => {
    appState.activeModels = []
    decisionAs('ready')
    const { unmount } = render(<ApiPage />)
    expect(await screen.findByText('api:status.ready')).toBeInTheDocument()
    unmount()

    decisionAs('starting')
    render(<ApiPage />)
    expect(await screen.findByText(/api:status\.starting/)).toBeInTheDocument()
    expect(screen.getByText('api:status.noModel')).toBeInTheDocument()
  })

  it('leaves the decision field out while the module is off', async () => {
    render(<ApiPage />)
    await waitFor(() =>
      expect(useDecisionStore.getState().status?.state).toBe('disabled')
    )
    expect(
      screen.queryByText('api:strip.decisionModel')
    ).not.toBeInTheDocument()
  })

  it('names the embedding model by the id clients pass, with a text test to copy', async () => {
    appState.activeModels = []
    embeddingAs('ready', { modalities: ['text'], dims: 1024 })
    render(<ApiPage />)

    expect(await screen.findByText('bge-m3')).toBeInTheDocument()
    expect(screen.getByText('api:strip.embeddingModel')).toBeInTheDocument()
    expect(screen.getByText('api:status.ready')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'api:strip.copyImageTest' })
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'api:strip.copyEmbeddingModel' })
    )
    await waitFor(() => expect(copied).toHaveBeenCalledTimes(1))
    expect(copied).toHaveBeenLastCalledWith('bge-m3')

    fireEvent.click(
      screen.getByRole('button', { name: 'api:strip.copyTextTest' })
    )
    await waitFor(() => expect(copied).toHaveBeenCalledTimes(2))
    const [curl] = copied.mock.calls[1] as [string]
    expect(curl).toContain("curl -X POST 'http://127.0.0.1:1337/v1/embeddings'")
    // BGE-M3 has no query prefix: none is forced on it.
    expect(curl).toContain(
      '"model":"bge-m3","input":"Why is the sky blue?","encoding_format":"float"'
    )
    expect(curl).not.toContain('Authorization')
  })

  it('reads a local image file for a model that reads images, and uses its query prefix, with the key header when the server needs one', async () => {
    useLocalApiServer.getState().setApiKey('secret')
    // Until the process reports what it reads, the catalog says.
    embeddingAs('starting', { model_id: 'embeddinggemma-2' })
    render(<ApiPage />)

    expect(await screen.findByText('embeddinggemma-2')).toBeInTheDocument()
    expect(screen.getByText(/api:status\.starting/)).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'api:strip.copyImageTest' })
    )
    await waitFor(() => expect(copied).toHaveBeenCalledTimes(1))
    const [command] = copied.mock.calls[0] as [string]
    expect(command).toMatch(/^IMAGE=photo\.jpg\n/)
    expect(command).toContain('base64 < "$IMAGE"')
    expect(command).toContain('--data-binary @-')
    expect(command).toContain("-H 'Authorization: Bearer YOUR_API_KEY'")
    // No placeholder ever goes out as if it were an image.
    expect(command).not.toContain('base64,...')
    expect(command).not.toContain('secret')

    fireEvent.click(
      screen.getByRole('button', { name: 'api:strip.copyTextTest' })
    )
    await waitFor(() => expect(copied).toHaveBeenCalledTimes(2))
    expect(copied.mock.calls[1]?.[0]).toContain(
      '"input":"task: search result | query: Why is the sky blue?"'
    )
  })

  it.each(['disabled', 'failed'] as const)(
    'leaves the embedding field out while the module is %s',
    async (state) => {
      embeddingAs(state)
      render(<ApiPage />)
      await waitFor(() =>
        expect(useEmbeddingStore.getState().status?.state).toBe(state)
      )
      expect(
        screen.queryByText('api:strip.embeddingModel')
      ).not.toBeInTheDocument()
    }
  )

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

  it('hosts Remote & LAN on the same server control as the header button', () => {
    render(<ApiPage />)
    expect(
      screen.getByRole('region', { name: 'remote-lan' })
    ).toBeInTheDocument()
    expect(sectionServer).toHaveBeenCalledWith(control)
  })

  it('leaves Remote & LAN out where there is no Local API Server', () => {
    features.localApiServer = false
    render(<ApiPage />)
    expect(
      screen.queryByRole('region', { name: 'remote-lan' })
    ).not.toBeInTheDocument()
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
