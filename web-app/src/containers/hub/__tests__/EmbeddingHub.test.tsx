import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalEmbeddingModel } from '@/lib/embedding/models'
import type { EmbeddingCatalogModel } from '@/services/embedding-catalog-registry'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <header>{children}</header>
  ),
}))

vi.mock('@/containers/hub/EmbeddingModelDetailPanel', () => ({
  EmbeddingModelDetailPanel: ({
    model,
  }: {
    model: EmbeddingCatalogModel | null
  }) => <aside data-testid="detail">{model?.id ?? 'none'}</aside>,
  LocalEmbeddingModelDetailPanel: ({
    model,
  }: {
    model: LocalEmbeddingModel
  }) => <aside data-testid="detail">{`local ${model.id}`}</aside>,
}))

const local = vi.hoisted(() => ({ models: [] as LocalEmbeddingModel[] }))
vi.mock('@/hooks/useEmbeddingModel', () => ({
  useLocalEmbeddingModels: () => local.models,
}))

const miniLm: LocalEmbeddingModel = {
  id: 'sentence-transformer-mini',
  name: 'sentence-transformer-mini',
  model_path: 'llamacpp/models/sentence-transformer-mini/model.gguf',
  mmproj_path: '',
}

import { useEmbeddingStore } from '@/stores/embedding-store'
import { getBaselineEmbeddingCatalog } from '@/services/embedding-catalog-registry'
import { filterEmbeddingModels } from '@/lib/hub-media'
import { EmbeddingHub } from '../EmbeddingHub'

const catalog = getBaselineEmbeddingCatalog()
const bind = vi.fn(() => () => {})

function renderHub(
  props: Partial<React.ComponentProps<typeof EmbeddingHub>> = {}
) {
  const onSelectModel = vi.fn()
  const onQueryChange = vi.fn()
  render(
    <EmbeddingHub
      query=""
      onQueryChange={onQueryChange}
      selectedModelId="bge-m3"
      onSelectModel={onSelectModel}
      {...props}
    />
  )
  return { onSelectModel, onQueryChange }
}

const listedRepos = () =>
  screen
    .getAllByRole('button')
    .map((b) => catalog.models.find((m) => b.textContent?.includes(m.repo)))
    .filter(Boolean)
    .map((m) => m!.id)

describe('EmbeddingHub', () => {
  beforeEach(() => {
    bind.mockClear()
    local.models = []
    useEmbeddingStore.setState({ catalog, installed: {}, bind })
  })

  it('leads with the default model, then the rest in catalog order, and follows the core', () => {
    renderHub()

    expect(
      screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    ).toEqual(['hub:available'])
    expect(listedRepos()).toEqual([
      'embeddinggemma-2',
      'embeddinggemma-300m',
      'qwen3-embedding-0.6b',
      'qwen3-vl-embedding-2b',
      'nomic-embed-text-v1.5',
      'bge-m3',
    ])
    expect(bind).toHaveBeenCalledOnce()
  })

  it('lists the downloaded models first', () => {
    useEmbeddingStore.setState({ installed: { 'bge-m3': true } })
    renderHub()

    expect(
      screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    ).toEqual(['hub:downloaded', 'hub:available'])
    expect(listedRepos()[0]).toBe('bge-m3')
  })

  it('tags a model with what it reads beyond text', () => {
    renderHub()

    expect(
      screen.getByTestId('embedding-modality-embeddinggemma-2-image')
    ).toHaveTextContent('hub:embeddingModality.image')
    expect(
      screen.getByTestId('embedding-modality-embeddinggemma-2-audio')
    ).toBeVisible()
    expect(
      screen.queryByTestId('embedding-modality-bge-m3-text')
    ).not.toBeInTheDocument()
  })

  it('marks the open model and reports a pick', async () => {
    const { onSelectModel } = renderHub()

    expect(screen.getByRole('button', { current: true })).toHaveTextContent(
      'BGE-M3'
    )
    expect(screen.getByTestId('detail')).toHaveTextContent('bge-m3')

    await userEvent.click(screen.getByRole('button', { name: /Nomic Embed/ }))
    expect(onSelectModel).toHaveBeenCalledWith('nomic-embed-text-v1.5')
  })

  it('opens on the default model when the URL names none', () => {
    const { onSelectModel } = renderHub({ selectedModelId: null })

    expect(screen.getByTestId('detail')).toHaveTextContent('none')
    expect(onSelectModel).toHaveBeenCalledWith('embeddinggemma-2', {
      replace: true,
    })
  })

  it('lists the embedding GGUFs among the llama.cpp models after the downloaded ones, the document-search model among them', async () => {
    local.models = [miniLm]
    useEmbeddingStore.setState({ installed: { 'bge-m3': true } })
    const { onSelectModel } = renderHub()

    expect(
      screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    ).toEqual([
      'hub:downloaded',
      'settings:embedding.localModel',
      'hub:available',
    ])
    const section = screen.getByTestId('embedding-local-models')
    expect(section).toHaveTextContent('sentence-transformer-mini')
    expect(section).toHaveTextContent('settings:embedding.documentSearchModel')

    await userEvent.click(
      within(section).getByRole('button', { name: /sentence-transformer-mini/ })
    )
    expect(onSelectModel).toHaveBeenCalledWith(
      'llamacpp:sentence-transformer-mini'
    )
  })

  it('opens a llama.cpp model the URL names, and keeps its key while the models are read', () => {
    local.models = [miniLm]
    const { onSelectModel } = renderHub({
      selectedModelId: 'llamacpp:sentence-transformer-mini',
    })
    expect(screen.getByTestId('detail')).toHaveTextContent(
      'local sentence-transformer-mini'
    )
    expect(screen.getByRole('button', { current: true })).toHaveTextContent(
      'sentence-transformer-mini'
    )
    expect(onSelectModel).not.toHaveBeenCalled()
  })

  it('finds a llama.cpp model by the search too', () => {
    local.models = [miniLm]
    renderHub({ query: 'mini' })
    expect(screen.getByTestId('embedding-local-models')).toBeVisible()
    expect(screen.queryByText('hub:noModels')).not.toBeInTheDocument()
  })

  it('narrows the list by the search and offers to clear an empty one', async () => {
    const { onQueryChange } = renderHub({ query: 'zzz' })

    expect(screen.getByText('hub:noModels')).toBeVisible()
    const main = screen.getByTestId('embedding-hub')
    expect(within(main).queryByText('BGE-M3')).not.toBeInTheDocument()
    const noResults = screen.getByText('hub:noModels').parentElement!
    await userEvent.click(
      within(noResults).getByRole('button', { name: 'hub:clearSearch' })
    )
    expect(onQueryChange).toHaveBeenCalledWith('')
  })
})

describe('filterEmbeddingModels', () => {
  it('needs every word in the name, description or repo', () => {
    const ids = (q: string) =>
      filterEmbeddingModels(catalog.models, q).map((m) => m.id)
    expect(ids('')).toHaveLength(catalog.models.length)
    expect(ids('qwen')).toEqual([
      'qwen3-embedding-0.6b',
      'qwen3-vl-embedding-2b',
    ])
    expect(ids('google images')).toEqual(['embeddinggemma-2'])
    expect(ids('ggml-org')).toEqual(['embeddinggemma-300m', 'bge-m3'])
    expect(ids('qwen nothing')).toEqual([])
  })
})
