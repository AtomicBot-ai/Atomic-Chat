import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hubModelFacts } from '@/lib/hub-model-facts'
import type { CatalogModel } from '@/services/models/types'

const mocks = vi.hoisted(() => ({
  fetchModelStats: vi.fn(async () => ({})),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))

// The download options have tests of their own.
vi.mock('@/containers/hub/DownloadOptionsSelect', () => ({
  DownloadOptionsSelect: ({ model }: { model: CatalogModel }) => (
    <section data-testid="download-options">{model.model_name}</section>
  ),
}))

vi.mock('@/lib/model-card', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/model-card')>('@/lib/model-card')
  return { ...actual, fetchModelStats: mocks.fetchModelStats }
})

import { ModelDetailPanel } from '../ModelDetailPanel'

const GB = 1024 ** 3
const BUDGET = 32 * GB

const model = (overrides: Partial<CatalogModel> = {}): CatalogModel =>
  ({
    model_name: 'Qwen/Qwen3.5-4B-GGUF',
    developer: 'Qwen',
    downloads: 4200,
    likes: 77,
    num_quants: 1,
    quants: [
      { model_id: 'Qwen3.5-4B-Q4_K_M', path: 'q4.gguf', file_size: '2.50 GB' },
    ],
    ...overrides,
  }) as CatalogModel

function renderPanel(
  entry: CatalogModel = model(),
  props: Partial<React.ComponentProps<typeof ModelDetailPanel>> = {}
) {
  const onCollapse = vi.fn()
  const onToggleLike = vi.fn()
  const facts = hubModelFacts(entry, { budgetBytes: BUDGET })
  render(
    <ModelDetailPanel
      model={entry}
      name="Qwen3.5 4B"
      facts={facts}
      engines={facts.engines}
      budgetBytes={BUDGET}
      liked={false}
      onToggleLike={onToggleLike}
      onCollapse={onCollapse}
      {...props}
    />
  )
  return { onCollapse, onToggleLike }
}

/** The value under one label of the facts grid. */
const fact = (label: string) =>
  screen.getByText(label).nextElementSibling as HTMLElement

describe('ModelDetailPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchModelStats.mockResolvedValue({})
  })

  it('heads the open row with the name, the repo and its numbers', () => {
    renderPanel(model({ last_modified: '2026-08-01T00:00:00Z' }))

    const collapse = screen.getByRole('button', {
      name: 'hub:table.collapse {"name":"Qwen3.5 4B"}',
    })
    expect(collapse).toHaveAttribute('aria-expanded', 'true')
    expect(within(collapse).getByText('Qwen3.5 4B')).toBeInTheDocument()
    expect(
      within(collapse).getByText('Qwen/Qwen3.5-4B-GGUF')
    ).toBeInTheDocument()
    expect(within(collapse).getByText(/^4.200$/)).toBeInTheDocument()
    expect(within(collapse).getByText('77')).toBeInTheDocument()
    expect(within(collapse).getByText(/^hub:updatedAgo/)).toBeInTheDocument()
  })

  it('lists what the listing knows, then the download options', () => {
    renderPanel()

    expect(fact('hub:table.column.parameters')).toHaveTextContent('4B')
    expect(fact('hub:table.column.format')).toHaveTextContent('GGUF')
    expect(fact('hub:table.column.engines')).toHaveTextContent(
      'llama.cpp, llama.cpp turboquant'
    )
    expect(fact('hub:table.column.context')).toHaveTextContent(
      'hub:table.unknown'
    )
    expect(fact('hub:table.column.downloadSize')).toHaveTextContent('2.5 GB')
    // The weights' size, which the device is judged by — not a guess above it.
    expect(fact('hub:table.column.estRam')).toHaveTextContent('≈ 2.5 GB')
    expect(fact('hub:table.column.thisDevice')).toHaveTextContent('Good fit')
    expect(fact('hub:table.column.uncensored')).toHaveTextContent(
      'hub:table.uncensoredNo'
    )
    const facts = screen.getByText('hub:table.column.parameters').closest('dl')!
    expect(
      facts.compareDocumentPosition(screen.getByTestId('download-options')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("prefers Hugging Face's own parameters and context once they arrive", async () => {
    mocks.fetchModelStats.mockResolvedValue({ params: '4.2B', context: '256K' })
    renderPanel()

    await waitFor(() =>
      expect(fact('hub:table.column.parameters')).toHaveTextContent('4.2B')
    )
    expect(fact('hub:table.column.context')).toHaveTextContent('256K')
    expect(mocks.fetchModelStats).toHaveBeenCalledWith('Qwen/Qwen3.5-4B-GGUF')
  })

  it('links the repo on Hugging Face in place of a README', () => {
    renderPanel()

    expect(
      screen.getByRole('link', { name: /hub:source.huggingFace/ })
    ).toHaveAttribute('href', 'https://huggingface.co/Qwen/Qwen3.5-4B-GGUF')
    expect(screen.queryByText('hub:readme')).not.toBeInTheDocument()
  })

  it("names Microsoft's catalog for a Foundry Local model and asks Hugging Face nothing", () => {
    renderPanel(
      {
        model_name: 'foundry-local/phi-4-mini',
        description: '',
        downloads: 0,
        is_foundry_local: true,
        foundry_local: {
          origin: 'microsoft',
          model_id: 'phi-4-mini',
          name: 'Phi-4 mini',
          summary: '',
          context_length: 131072,
          variants: [],
        },
      } as CatalogModel,
      { name: 'Phi-4 mini' }
    )

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(
      screen.getByText('hub:foundryLocal.microsoftCatalog')
    ).toBeInTheDocument()
    expect(screen.getByText('phi-4-mini')).toBeInTheDocument()
    expect(fact('hub:table.column.context')).toHaveTextContent('128K')
    expect(fact('hub:table.column.engines')).toHaveTextContent('Foundry Local')
    // Each variant is judged in the download options, not by one size here.
    expect(fact('hub:table.column.thisDevice')).toHaveTextContent(
      'hub:table.deviceInCard'
    )
    expect(mocks.fetchModelStats).not.toHaveBeenCalled()
  })

  it('collapses from its header and keeps the heart beside it', async () => {
    const user = userEvent.setup()
    const { onCollapse, onToggleLike } = renderPanel(model(), { liked: true })

    const heart = screen.getByRole('button', {
      name: 'hub:table.unlike {"name":"Qwen3.5 4B"}',
    })
    expect(heart).toHaveAttribute('aria-pressed', 'true')
    await user.click(heart)
    expect(onToggleLike).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { expanded: true }))
    expect(onCollapse).toHaveBeenCalledOnce()
  })
})
