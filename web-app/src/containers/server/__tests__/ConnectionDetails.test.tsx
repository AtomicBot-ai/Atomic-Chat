import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appState } = vi.hoisted(() => ({
  appState: {
    serverStatus: 'running' as 'running' | 'stopped' | 'pending',
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

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

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

import { useRemoteAccessStore } from '@/hooks/useRemoteAccess'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import type { DecisionService, DecisionState } from '@/services/decision/types'
import type {
  EmbeddingService,
  EmbeddingStatus,
} from '@/services/embedding/types'
import { useDecisionStore } from '@/stores/decision-store'
import { useEmbeddingStore } from '@/stores/embedding-store'
import { seedServiceHub } from '@/test/service-hub'

import { ConnectionDetails } from '../ConnectionDetails'

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

describe('Server → Connections, connection details', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appState.serverStatus = 'running'
    appState.activeModels = ['gemma-4']
    useRemoteAccessStore.getState().reset()
    useLocalApiServer.setState({ serverHost: '127.0.0.1' })
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
    render(<ConnectionDetails />)
    expect(await screen.findByText('Laya Multilingual')).toBeInTheDocument()
    expect(screen.getByText('api:strip.decisionModel')).toBeInTheDocument()
    expect(screen.getByText('gemma-4')).toBeInTheDocument()
  })

  it('reads Ready from a decision model alone, and marks one still starting', async () => {
    appState.activeModels = []
    decisionAs('ready')
    const { unmount } = render(<ConnectionDetails />)
    expect(await screen.findByText('api:status.ready')).toBeInTheDocument()
    unmount()

    decisionAs('starting')
    render(<ConnectionDetails />)
    expect(await screen.findByText(/api:status\.starting/)).toBeInTheDocument()
    expect(screen.getByText('api:status.noModel')).toBeInTheDocument()
  })

  it('leaves the decision field out while the module is off', async () => {
    render(<ConnectionDetails />)
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
    render(<ConnectionDetails />)

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
    render(<ConnectionDetails />)

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
      render(<ConnectionDetails />)
      await waitFor(() =>
        expect(useEmbeddingStore.getState().status?.state).toBe(state)
      )
      expect(
        screen.queryByText('api:strip.embeddingModel')
      ).not.toBeInTheDocument()
    }
  )

  it('gives the address to copy and says who can reach it and whether it wants a key', async () => {
    render(<ConnectionDetails />)

    expect(screen.getByText('api:connections.details')).toBeInTheDocument()
    expect(screen.getByText('http://127.0.0.1:1337/v1')).toBeInTheDocument()
    expect(screen.getByText('api:connections.accessDevice')).toBeInTheDocument()
    expect(screen.getByText('api:connections.noKey')).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: /api:connections\.copyUrl/ })
    )
    await waitFor(() =>
      expect(copied).toHaveBeenCalledWith('http://127.0.0.1:1337/v1')
    )
  })

  it('reads the local network, the tunnel and a key from the live settings', () => {
    act(() => {
      useLocalApiServer.setState({ serverHost: '0.0.0.0' })
      useLocalApiServer.getState().setApiKey('secret')
    })
    const { unmount } = render(<ConnectionDetails />)
    expect(
      screen.getByText('api:connections.accessNetwork')
    ).toBeInTheDocument()
    expect(screen.getByText('api:connections.keyRequired')).toBeInTheDocument()
    unmount()

    act(() => {
      useRemoteAccessStore.getState().applyStatus(
        {
          state: 'online',
          url: 'https://quiet-river.trycloudflare.com',
          error: null,
          blockReason: null,
          canStart: false,
          canStop: true,
          serverHasApiKey: true,
        },
        'event'
      )
    })
    render(<ConnectionDetails />)
    expect(screen.getByText('api:connections.accessRemote')).toBeInTheDocument()
  })

  it('says the server is stopped', () => {
    appState.serverStatus = 'stopped'
    render(<ConnectionDetails />)
    expect(screen.getByText('api:status.stopped')).toBeInTheDocument()
  })
})
