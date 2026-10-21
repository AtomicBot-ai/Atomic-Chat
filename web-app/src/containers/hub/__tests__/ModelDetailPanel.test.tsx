import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hubModelFacts } from '@/lib/hub-model-facts'
import type { CatalogModel } from '@/services/models/types'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  language: 'en',
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
    i18n: { language: mocks.language },
  }),
}))

// The download options have tests of their own.
vi.mock('@/containers/hub/DownloadOptionsSelect', () => ({
  DownloadOptionsSelect: ({ model }: { model: CatalogModel }) => (
    <section data-testid="download-options">{model.model_name}</section>
  ),
}))

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
    mocks.language = 'en'
    // The open row asks nothing itself: its facts are the row's.
    vi.stubGlobal('fetch', mocks.fetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
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

  it('says when the repo was updated in the interface language, plural forms and all', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-02T12:00:00Z'))
    renderPanel(model({ last_modified: '2026-08-01T00:00:00Z' }))
    // One day, not the hand-built "1 days ago".
    expect(
      screen.getByText('hub:updatedAgo {"ago":"1 day ago"}')
    ).toBeInTheDocument()
  })

  it('formats the age in Russian with its own plural form', () => {
    mocks.language = 'ru'
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-04T12:00:00Z'))
    renderPanel(model({ last_modified: '2026-08-01T00:00:00Z' }))
    expect(
      screen.getByText('hub:updatedAgo {"ago":"3 дня назад"}')
    ).toBeInTheDocument()
  })

  it('lists what the listing knows, then the download options', () => {
    renderPanel()

    expect(fact('hub:table.column.parameters')).toHaveTextContent('4B')
    expect(fact('hub:table.column.format')).toHaveTextContent('GGUF')
    expect(fact('hub:table.column.engines')).toHaveTextContent(
      'llama.cpp, llama.cpp turboquant'
    )
    expect(fact('hub:table.column.downloadSize')).toHaveTextContent('2.5 GB')
    expect(fact('hub:table.column.thisDevice')).toHaveTextContent('Good fit')
    // Context, the RAM estimate and the uncensored tag are not listed.
    for (const gone of ['context', 'estRam', 'uncensored']) {
      expect(
        screen.queryByText(`hub:table.column.${gone}`)
      ).not.toBeInTheDocument()
    }
    const facts = screen.getByText('hub:table.column.parameters').closest('dl')!
    expect(
      facts.compareDocumentPosition(screen.getByTestId('download-options')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  describe('a linked checkpoint no engine here serves', () => {
    const checkpoint = () =>
      model({
        model_name: 'nvidia/Gemma-4-31B-IT-NVFP4',
        developer: 'nvidia',
        num_quants: 0,
        quants: [],
        num_safetensors: 1,
      })

    it('says what it runs on in place of the download options, and reads as safetensors', () => {
      renderPanel(checkpoint(), { formatLabel: 'Safetensors', unserved: {} })

      expect(fact('hub:table.column.format')).toHaveTextContent('Safetensors')
      expect(screen.getByTestId('unserved-checkpoint')).toHaveTextContent(
        /^hub:safetensorsNeedsNvidia$/
      )
      expect(screen.queryByTestId('download-options')).not.toBeInTheDocument()
    })

    it("says, in the engine's own words, that the card is too old", () => {
      renderPanel(checkpoint(), {
        formatLabel: 'Safetensors',
        unserved: {
          tooOld: {
            engine: { id: 'vllm', label: 'vLLM', i18n: 'vllm' } as never,
            required: '8.0',
            actual: '7.5',
          },
        },
      })

      expect(screen.getByTestId('unserved-checkpoint')).toHaveTextContent(
        'hub:vllm.blocker.compute-capability-too-low {"required":"8.0","actual":"7.5"}'
      )
      expect(screen.queryByTestId('download-options')).not.toBeInTheDocument()
    })
  })

  it('names the parameters the row names, and asks Hugging Face nothing itself', () => {
    const entry = model({ model_name: 'inclusionAI/Ling-3.0-flash-GGUF' })
    renderPanel(entry, {
      facts: {
        ...hubModelFacts(entry, { budgetBytes: BUDGET }),
        params: '104B',
      },
    })

    expect(fact('hub:table.column.parameters')).toHaveTextContent('104B')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('holds the place of what is still on its way, so nothing jumps when it lands', () => {
    const entry = model({
      model_name: 'bartowski/Ling-3.0-flash-GGUF',
      quants: undefined,
    })
    renderPanel(entry, { paramsLoading: true, cardLoading: true })

    for (const label of [
      'hub:table.column.parameters',
      'hub:table.column.downloadSize',
      'hub:table.column.thisDevice',
    ]) {
      expect(
        within(fact(label)).getByRole('status', { name: 'hub:table.loading' })
      ).toBeInTheDocument()
    }
    // The download options' frame is there already, with its heading.
    const pending = screen.getByTestId('download-options-pending')
    expect(within(pending).getByText('hub:downloadOptions')).toBeInTheDocument()
    expect(screen.queryByTestId('download-options')).not.toBeInTheDocument()
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
    expect(fact('hub:table.column.engines')).toHaveTextContent('Foundry Local')
    // Each variant is judged in the download options, not by one size here.
    expect(fact('hub:table.column.thisDevice')).toHaveTextContent(
      'hub:table.deviceInCard'
    )
    expect(mocks.fetch).not.toHaveBeenCalled()
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
