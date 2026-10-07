import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
}))

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
