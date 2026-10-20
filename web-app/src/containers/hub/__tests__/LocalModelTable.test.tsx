import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HubEngineId } from '@/lib/hub-model-engines'
import type { CatalogModel } from '@/services/models/types'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))

// The open row's body has tests of its own; here it only says which row it is.
vi.mock('@/containers/hub/ModelDetailPanel', () => ({
  ModelDetailPanel: ({
    model,
    onCollapse,
  }: {
    model: CatalogModel
    onCollapse: () => void
  }) => (
    <div data-testid="open-row">
      {model.model_name}
      <button type="button" onClick={onCollapse}>
        collapse
      </button>
    </div>
  ),
}))

import {
  LocalModelTable,
  type LocalModelTableItem,
  type LocalModelTableProps,
} from '../LocalModelTable'
import { useModelLikes } from '@/hooks/useModelLikes'

const GB = 1024 ** 3

const gguf = (
  name: string,
  size: string | undefined,
  extra: Partial<CatalogModel> = {}
) =>
  ({
    model_name: name,
    developer: name.split('/')[0],
    downloads: 1,
    num_quants: size ? 1 : 0,
    quants: size
      ? [{ model_id: `${name}-Q4_K_M`, path: 'q4.gguf', file_size: size }]
      : [],
    ...extra,
  }) as CatalogModel

const ALL_ENGINES = new Set<HubEngineId>([
  'llamacpp-upstream',
  'llamacpp',
  'mlx',
  'atomic-prism',
  'vllm',
  'sglang',
  'tensorrt-llm',
  'foundry-local',
])

/** Records every observer, so a test says which rows come on screen. */
class Observers {
  static all: Observers[] = []
  readonly targets: Element[] = []
  constructor(private readonly callback: IntersectionObserverCallback) {
    Observers.all.push(this)
  }
  observe(target: Element) {
    this.targets.push(target)
  }
  unobserve() {}
  disconnect() {
    Observers.all = Observers.all.filter((observer) => observer !== this)
  }
  takeRecords() {
    return []
  }
  show(ids: string[], isIntersecting = true) {
    const entries = this.targets
      .filter((target) =>
        ids.includes((target as HTMLElement).dataset.modelRow ?? '')
      )
      .map(
        (target) => ({ target, isIntersecting }) as IntersectionObserverEntry
      )
    this.callback(entries, this as unknown as IntersectionObserver)
  }
}

function renderTable(props: Partial<LocalModelTableProps> = {}) {
  const items: LocalModelTableItem[] = props.items ?? [
    {
      model: gguf('Qwen/Qwen3.5-4B-GGUF', '2.50 GB'),
      pick: { model_name: 'Qwen/Qwen3.5-4B-GGUF', title: 'Qwen3.5 4B' },
      section: 'Recommended',
    },
    {
      model: gguf('google/gemma-4-27b-GGUF', '17.00 GB'),
      pick: { model_name: 'google/gemma-4-27b-GGUF', title: 'Gemma 4 27B' },
      section: 'Recommended',
    },
    {
      model: gguf('bartowski/Llama-4-8B-GGUF', undefined),
      fromHuggingFace: true,
      section: 'More from Hugging Face',
    },
  ]
  const onSelect = vi.fn()
  const view = render(
    <LocalModelTable
      selected={null}
      onSelect={onSelect}
      budgetBytes={20 * GB}
      availableEngines={ALL_ENGINES}
      {...props}
      items={items}
    />
  )
  return { ...view, onSelect, items }
}

const summaryRows = () =>
  screen
    .getAllByRole('row')
    .filter((row) => row.classList.contains('local-model-summary'))

const cell = (row: HTMLElement, column: string) => {
  const index = screen
    .getAllByRole('columnheader')
    .findIndex((header) => header.dataset.column === column)
  return within(row).getAllByRole('cell')[index]
}

describe('LocalModelTable', () => {
  beforeEach(() => {
    Observers.all = []
    vi.stubGlobal('IntersectionObserver', Observers)
    useModelLikes.setState({ liked: [], onlyLiked: false })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('heads each section with a row of its own and counts the models', () => {
    renderTable()

    expect(
      screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    ).toEqual(['Recommended', 'More from Hugging Face'])
    expect(screen.getByText(/hub:table.count/)).toHaveTextContent('"count":3')
    expect(
      screen
        .getAllByRole('columnheader')
        .map((h) => h.dataset.column)
        .filter(Boolean)
    ).toEqual([
      'model',
      'parameters',
      'format',
      'context',
      'capabilities',
      'downloadSize',
      'estRam',
      'thisDevice',
      'uncensored',
      'engines',
    ])
  })

  it('fills each column from the listing, the fit as the download card reads it', () => {
    renderTable()

    const [qwen, gemma, llama] = summaryRows()
    expect(cell(qwen, 'parameters')).toHaveTextContent('4B')
    expect(cell(qwen, 'format')).toHaveTextContent('GGUF')
    expect(cell(qwen, 'downloadSize')).toHaveTextContent('2.5 GB')
    expect(cell(qwen, 'estRam')).toHaveTextContent('≈ 2.5 GB')
    expect(cell(qwen, 'thisDevice')).toHaveTextContent('Good fit')
    // 17 GB of a 20 GB budget: past the 70% that fits well.
    expect(cell(gemma, 'thisDevice')).toHaveTextContent('Might fit')
    expect(cell(qwen, 'uncensored')).toHaveTextContent('hub:table.uncensoredNo')
    expect(cell(qwen, 'engines')).toHaveTextContent('llama.cpp+1')
    // A Hugging Face row without its card yet: nothing is guessed.
    expect(cell(llama, 'downloadSize')).toHaveTextContent('hub:table.unknown')
    expect(cell(llama, 'thisDevice')).toHaveTextContent('hub:table.unknown')
    expect(llama).toHaveAttribute('data-source', 'huggingface')
    expect(qwen).toHaveAttribute('data-source', 'recommended')
    expect(
      within(llama).getByRole('img', { name: 'hub:fromHuggingFace' })
    ).toBeInTheDocument()
  })

  it('names only the engines this machine offers', () => {
    renderTable({
      availableEngines: new Set<HubEngineId>(['llamacpp-upstream']),
    })

    expect(cell(summaryRows()[0], 'engines')).toHaveTextContent(/^llama\.cpp$/)
  })

  it('reads a managed checkpoint as the format shown and a Foundry model as its catalog', () => {
    renderTable({
      format: 'vllm',
      items: [
        {
          model: {
            model_name: 'Qwen/Qwen3-8B-FP8',
            developer: 'Qwen',
            downloads: 1,
            is_managed: true,
            managed: { parameters: { F8_E4M3: 8e9 } },
          } as CatalogModel,
        },
        {
          model: {
            model_name: 'foundry-local/phi-4-mini',
            description: '',
            downloads: 0,
            is_foundry_local: true,
            foundry_local: {
              origin: 'microsoft',
              model_id: 'phi-4-mini',
              name: 'Phi-4 mini',
              summary: '',
              variants: [],
            },
          } as unknown as CatalogModel,
        },
      ],
    })

    const [qwen, phi] = summaryRows()
    expect(cell(qwen, 'format')).toHaveTextContent('vLLM')
    expect(cell(qwen, 'parameters')).toHaveTextContent('8B')
    expect(cell(qwen, 'thisDevice')).toHaveTextContent('hub:table.deviceInCard')
    expect(within(phi).getByText('Phi-4 mini')).toBeInTheDocument()
    expect(
      within(phi).getByText('hub:foundryLocal.microsoftCatalog')
    ).toBeInTheDocument()
    expect(cell(phi, 'format')).toHaveTextContent('Foundry Local')
    expect(cell(phi, 'engines')).toHaveTextContent('Foundry Local')
  })

  it('sorts by a column, unknown values last either way, as one list', async () => {
    const user = userEvent.setup()
    renderTable()

    const sizeHeader = screen.getByRole('button', {
      name: /hub:table.sortBy.*downloadSize/,
    })
    await user.click(sizeHeader)
    expect(summaryRows().map((row) => row.dataset.modelRow)).toEqual([
      'Qwen/Qwen3.5-4B-GGUF',
      'google/gemma-4-27b-GGUF',
      'bartowski/Llama-4-8B-GGUF',
    ])
    expect(
      screen
        .getAllByRole('columnheader')
        .find((header) => header.dataset.column === 'downloadSize')
    ).toHaveAttribute('aria-sort', 'ascending')
    // Sections would only interleave.
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()

    await user.click(sizeHeader)
    expect(summaryRows().map((row) => row.dataset.modelRow)).toEqual([
      'google/gemma-4-27b-GGUF',
      'Qwen/Qwen3.5-4B-GGUF',
      'bartowski/Llama-4-8B-GGUF',
    ])

    await user.click(
      screen.getByRole('button', { name: 'hub:table.resetSort' })
    )
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(2)
  })

  it('opens a row in place of its summary and closes it again', async () => {
    const user = userEvent.setup()
    const { onSelect, rerender, items } = renderTable()

    await user.click(
      screen.getByRole('button', { name: /hub:table.expand.*Gemma 4 27B/ })
    )
    expect(onSelect).toHaveBeenCalledWith('google/gemma-4-27b-GGUF')

    rerender(
      <LocalModelTable
        items={items}
        selected="google/gemma-4-27b-GGUF"
        onSelect={onSelect}
        budgetBytes={20 * GB}
        availableEngines={ALL_ENGINES}
      />
    )
    expect(summaryRows()).toHaveLength(2)
    const rows = screen.getAllByRole('row')
    const open = rows.findIndex((row) =>
      row.contains(screen.getByTestId('open-row'))
    )
    expect(rows[open - 1]).toHaveTextContent('Qwen3.5 4B')
    expect(screen.getByTestId('open-row')).toHaveTextContent(
      'google/gemma-4-27b-GGUF'
    )

    await user.click(screen.getByText('collapse'))
    expect(onSelect).toHaveBeenLastCalledWith(null)
  })

  it('likes a row from its heart', async () => {
    const user = userEvent.setup()
    renderTable()

    await user.click(
      screen.getByRole('button', { name: /hub:table.like .*Qwen3.5 4B/ })
    )

    expect(useModelLikes.getState().liked).toEqual(['Qwen/Qwen3.5-4B-GGUF'])
    expect(
      screen.getByRole('button', { name: /hub:table.unlike .*Qwen3.5 4B/ })
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('reports the rows on screen in list order, and the end of the list', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame'] })
    const onVisibleRowsChange = vi.fn()
    const onEndVisibleChange = vi.fn()
    renderTable({ onVisibleRowsChange, onEndVisibleChange })

    // Nothing is on screen until it is measured.
    expect(onEndVisibleChange.mock.calls).toEqual([[false]])
    const [observer] = Observers.all
    expect(observer.targets).toHaveLength(3)

    act(() =>
      observer.show(['bartowski/Llama-4-8B-GGUF', 'Qwen/Qwen3.5-4B-GGUF'])
    )
    // Fewer rows than the prefetch margin: the first row is the end's mark.
    expect(onEndVisibleChange).toHaveBeenLastCalledWith(true)
    act(() => vi.advanceTimersToNextFrame())
    expect(onVisibleRowsChange).toHaveBeenLastCalledWith([
      'Qwen/Qwen3.5-4B-GGUF',
      'bartowski/Llama-4-8B-GGUF',
    ])

    act(() => observer.show(['Qwen/Qwen3.5-4B-GGUF'], false))
    act(() => vi.advanceTimersToNextFrame())
    expect(onEndVisibleChange).toHaveBeenLastCalledWith(false)
    expect(onVisibleRowsChange).toHaveBeenLastCalledWith([
      'bartowski/Llama-4-8B-GGUF',
    ])
    vi.useRealTimers()
  })

  it('measures again only when the rows change, starting from "not at the end"', () => {
    const onEndVisibleChange = vi.fn()
    const { rerender, items, onSelect } = renderTable({ onEndVisibleChange })
    const props = {
      selected: null,
      onSelect,
      budgetBytes: 20 * GB,
      availableEngines: ALL_ENGINES,
      onEndVisibleChange,
    }

    // A size filling in for a row is not a new list.
    rerender(
      <LocalModelTable
        {...props}
        items={items.map((item) =>
          item.fromHuggingFace
            ? { ...item, model: gguf(item.model.model_name, '3.00 GB') }
            : { ...item }
        )}
      />
    )
    expect(Observers.all).toHaveLength(1)
    expect(onEndVisibleChange).toHaveBeenCalledTimes(1)

    // A page arriving is.
    rerender(
      <LocalModelTable
        {...props}
        items={[
          ...items,
          {
            model: gguf('unsloth/Mistral-Next-GGUF', undefined),
            fromHuggingFace: true,
            section: 'More from Hugging Face',
          },
        ]}
      />
    )
    expect(Observers.all).toHaveLength(1)
    expect(Observers.all[0].targets).toHaveLength(4)
    expect(onEndVisibleChange.mock.calls).toEqual([[false], [false]])
  })
})
