import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalEmbeddingModel } from '@/lib/embedding/models'
import type { EmbeddingCatalogModel } from '@/services/embedding-catalog-registry'

const mocks = vi.hoisted(() => ({
  apiSupported: true,
  arch: '',
  versionBackend: undefined as string | undefined,
  local: [] as LocalEmbeddingModel[],
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    search,
    children,
  }: {
    to: string
    search?: Record<string, string>
    children: React.ReactNode
  }) => (
    <a href={`${to}?${new URLSearchParams(search).toString()}`}>{children}</a>
  ),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    embedding: () => ({ isSupported: () => mocks.apiSupported }),
  }),
}))

vi.mock('@/hooks/useHardware', () => ({
  useHardware: (
    selector: (s: { hardwareData: { cpu: { arch: string } } }) => unknown
  ) => selector({ hardwareData: { cpu: { arch: mocks.arch } } }),
}))

vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  return {
    ...actual,
    PlatformFeatures: { ...actual.PlatformFeatures, localInference: true },
  }
})

vi.mock('@/hooks/useBackendUpdater', () => ({
  useBackendUpdater: () => ({
    checkForEngineUpdate: vi.fn(),
    recheckOptimalBackend: vi.fn(),
    downloadRecommendedBackend: vi.fn(),
  }),
}))

vi.mock('@/hooks/useDecisionEngineReadiness', () => ({
  useEngineVersionBackend: () => mocks.versionBackend,
}))

vi.mock('@/hooks/useEmbeddingModel', () => ({
  useLocalEmbeddingModels: () => mocks.local,
}))

vi.mock('@/containers/EmbeddingModelCard', () => ({
  default: ({
    model,
    startBlocked,
  }: {
    model: EmbeddingCatalogModel
    startBlocked?: boolean
  }) => (
    <span>{`actions for ${model.id}${startBlocked ? ' (start blocked)' : ''}`}</span>
  ),
  EmbeddingModelStatus: ({ model }: { model: EmbeddingCatalogModel }) => (
    <span>{`status of ${model.id}`}</span>
  ),
  LocalEmbeddingModelActions: ({ model }: { model: LocalEmbeddingModel }) => (
    <span>{`local actions for ${model.id}`}</span>
  ),
  LocalEmbeddingModelStatus: ({ model }: { model: LocalEmbeddingModel }) => (
    <span>{`local status of ${model.id}`}</span>
  ),
}))

import { getBaselineEmbeddingCatalog } from '@/services/embedding-catalog-registry'
import { useEmbeddingStore } from '@/stores/embedding-store'
import { EmbeddingModelsSection } from '../EmbeddingModelsSection'

const bind = vi.fn(() => () => {})

describe('EmbeddingModelsSection', () => {
  beforeEach(() => {
    mocks.apiSupported = true
    mocks.arch = ''
    mocks.versionBackend = undefined
    mocks.local = []
    bind.mockClear()
    useEmbeddingStore.setState({
      catalog: getBaselineEmbeddingCatalog(),
      installed: { 'bge-m3': true },
      status: null,
      config: null,
      error: null,
      bind,
    })
  })

  it('lists only the downloaded models, each with its facts and actions', () => {
    render(<EmbeddingModelsSection />)

    expect(
      screen.getByRole('heading', { name: 'settings:embedding.sectionTitle' })
    ).toBeVisible()
    expect(screen.getByText('BGE-M3')).toBeVisible()
    expect(screen.getByText('actions for bge-m3')).toBeVisible()
    expect(screen.getByText('status of bge-m3')).toBeVisible()
    expect(screen.getByText(/settings:embedding\.dims/)).toBeVisible()
    expect(
      screen.queryByText('actions for embeddinggemma-2')
    ).not.toBeInTheDocument()
    expect(bind).toHaveBeenCalledOnce()
  })

  it('lists the llama.cpp models flagged as embedding GGUFs after the catalog ones', () => {
    mocks.local = [
      {
        id: 'sentence-transformer-mini',
        name: 'sentence-transformer-mini',
        model_path: 'llamacpp/models/sentence-transformer-mini/model.gguf',
        mmproj_path: '',
      },
    ]
    render(<EmbeddingModelsSection />)

    const rows = screen.getAllByText(/actions for /).map((el) => el.textContent)
    expect(rows).toEqual([
      'actions for bge-m3',
      'local actions for sentence-transformer-mini',
    ])
    expect(screen.getByText('settings:embedding.localModel')).toBeVisible()
    expect(
      screen.queryByText('settings:embedding.noneTitle')
    ).not.toBeInTheDocument()
  })

  it('sends to the Embedding category of the Hub when none is downloaded', () => {
    useEmbeddingStore.setState({ installed: {} })
    render(<EmbeddingModelsSection />)

    expect(screen.getByText('settings:embedding.noneTitle')).toBeVisible()
    expect(screen.getByRole('link', { name: 'common:hub' })).toHaveAttribute(
      'href',
      '/hub/?category=embedding'
    )
  })

  it('shows the failure, with the engine update next to an engine too old', () => {
    useEmbeddingStore.setState({
      error: {
        code: 'EMBEDDING_ENGINE_UNSUPPORTED',
        message: 'Update llama.cpp to b11454 or newer.',
      },
    })
    render(<EmbeddingModelsSection />)

    expect(screen.getByRole('alert')).toHaveTextContent(
      'settings:embedding.errors.engineUnsupported'
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Update llama.cpp to b11454 or newer.'
    )
    expect(
      screen.getByRole('button', { name: 'settings:embedding.updateEngine' })
    ).toBeVisible()
  })

  it.each([
    ['EMBEDDING_NOT_CONFIGURED', 'settings:embedding.errors.notConfigured'],
    ['EMBEDDING_MODEL_NOT_EMBEDDING', 'settings:embedding.errors.notEmbedding'],
    ['MODEL_FILE_NOT_FOUND', 'settings:embedding.errors.modelFileNotFound'],
    ['MODEL_LOAD_TIMED_OUT', 'settings:embedding.errors.generic'],
  ])('names %s', (code, text) => {
    useEmbeddingStore.setState({
      status: {
        state: 'failed',
        error: { code, message: 'm' },
      } as never,
    })
    render(<EmbeddingModelsSection />)
    expect(screen.getByRole('alert')).toHaveTextContent(text)
    expect(
      screen.queryByRole('button', { name: 'settings:embedding.updateEngine' })
    ).not.toBeInTheDocument()
  })

  it('asks for a newer llama.cpp before a model too new for it can start', () => {
    mocks.versionBackend = 'b11443/macos-arm64'
    useEmbeddingStore.setState({
      installed: { 'embeddinggemma-2': true, 'bge-m3': true },
    })
    render(<EmbeddingModelsSection />)

    expect(
      screen.getByText('actions for embeddinggemma-2 (start blocked)')
    ).toBeVisible()
    expect(screen.getByText('actions for bge-m3')).toBeVisible()
    expect(
      screen.getAllByText('settings:embedding.requiresEngine')
    ).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent(
      'settings:embedding.requiresEngineNotice'
    )
    expect(
      screen.getByRole('button', { name: 'settings:embedding.updateEngine' })
    ).toBeVisible()
  })

  it('renders nothing where embedding models cannot run', () => {
    mocks.apiSupported = false
    const { container } = render(<EmbeddingModelsSection />)

    expect(container).toBeEmptyDOMElement()
    expect(bind).not.toHaveBeenCalled()
  })
})
