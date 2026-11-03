import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_FONT_SIZE,
  expectFits,
  expectNoHorizontalOverflow,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'
import type { HubEngineId } from '@/lib/hub-model-engines'
import type { CatalogModel } from '@/services/models/types'
import { LocalModelTable, type LocalModelTableItem } from './LocalModelTable'

// The open row's download options are measured by their own layout tests;
// here they are a block of their usual height.
vi.mock('@/containers/hub/DownloadOptionsSelect', () => ({
  DownloadOptionsSelect: () => (
    <section className="h-24 rounded-lg border border-border" />
  ),
}))
// Parameter counts come from Hugging Face for names that carry none; none here.
vi.mock('@/lib/model-card', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/model-card')>('@/lib/model-card')
  return { ...actual, fetchModelParams: async () => undefined }
})

const GB = 1024 ** 3
const RAIL = 60
const SIDEBAR = 240
/** The list's width: the window less the rail, the open sidebar and the list's `p-2`. */
const listWidth = (window: number) => window - RAIL - SIDEBAR - 2 * 8

const ENGINES = new Set<HubEngineId>(['llamacpp-upstream', 'llamacpp'])

const gguf = (name: string, size?: string, extra: Partial<CatalogModel> = {}) =>
  ({
    model_name: name,
    developer: name.split('/')[0],
    downloads: 123456,
    likes: 789,
    num_quants: size ? 1 : 0,
    quants: size
      ? [{ model_id: `${name}-Q4_K_M`, path: 'q4.gguf', file_size: size }]
      : [],
    ...extra,
  }) as CatalogModel

// Worst cases: a long repo id, a two-digit GB size, all three fit verdicts.
const ITEMS: LocalModelTableItem[] = [
  {
    model: gguf('Qwen/Qwen3.5-4B-GGUF', '2.50 GB'),
    pick: {
      model_name: 'Qwen/Qwen3.5-4B-GGUF',
      title: 'Qwen3.5 4B',
      categories: ['vision', 'tools', 'reasoning'],
    },
    section: 'Recommended',
  },
  {
    model: gguf('google/gemma-4-27b-it-qat-GGUF', '17.40 GB'),
    pick: {
      model_name: 'google/gemma-4-27b-it-qat-GGUF',
      title: 'Gemma 4 27B',
    },
    section: 'Recommended',
  },
  {
    model: gguf(
      'mradermacher/Llama-3.3-Nemotron-Super-49B-v1.5-abliterated-i1-GGUF',
      '38.10 GB'
    ),
    fromHuggingFace: true,
    section: 'More from Hugging Face',
  },
  {
    model: gguf('bartowski/Mistral-Small-3.2-24B-Instruct-2506-GGUF'),
    fromHuggingFace: true,
    section: 'More from Hugging Face',
  },
]

function renderTable(width: number, selected: string | null = null) {
  return render(
    withTranslations(
      <div
        className="app-shell"
        style={{ height: 'auto', paddingTop: 0, overflow: 'visible' }}
      >
        <div data-testid="list" style={{ width }}>
          <LocalModelTable
            items={ITEMS}
            selected={selected}
            onSelect={() => {}}
            budgetBytes={24 * GB}
            availableEngines={ENGINES}
          />
        </div>
      </div>
    )
  )
}

const visibleColumns = () =>
  screen
    .getAllByRole('columnheader')
    .filter(
      (header) =>
        header.dataset.column && getComputedStyle(header).display !== 'none'
    )

/** Every word of `el`'s own text is laid out on one line: wrapped, never broken. */
function expectWholeWords(el: HTMLElement) {
  for (const node of el.childNodes) {
    if (node.nodeType !== Node.TEXT_NODE) continue
    const text = node.textContent ?? ''
    for (const match of text.matchAll(/\S+/g)) {
      const range = document.createRange()
      range.setStart(node, match.index)
      range.setEnd(node, match.index + match[0].length)
      const lines = [...range.getClientRects()].filter((r) => r.width > 0)
      expect(lines, `"${match[0]}" in "${text}"`).toHaveLength(1)
    }
  }
}

const summaries = () =>
  screen
    .getAllByRole('row')
    .filter((row) => row.classList.contains('local-model-summary'))

const visibleCells = (row: HTMLElement) =>
  within(row)
    .getAllByRole('cell')
    .filter((cell) => getComputedStyle(cell).display !== 'none')

describe('LocalModelTable layout', () => {
  beforeEach(() => {
    setTheme('light')
  })
  afterEach(() => {
    setFontSize(DEFAULT_FONT_SIZE)
  })

  for (const [label, size] of [
    ['Medium', DEFAULT_FONT_SIZE],
    ['Extra Large', XL_FONT_SIZE],
  ] as const) {
    for (const window of [1024, 1280]) {
      it(`lines every cell up under its header without sideways scroll (${window}px window with the sidebar, ${label})`, async () => {
        setFontSize(size)
        renderTable(listWidth(window))
        await settle()

        const list = screen.getByTestId('list')
        expectNoHorizontalOverflow(list)
        const headers = visibleColumns()
        for (const header of headers) {
          const sort = within(header).queryByRole('button')
          expectWholeWords(sort ?? header)
          if (!sort) continue
          // The arrow stays on its last word's line, never alone below it.
          const glued = sort.querySelector('span.whitespace-nowrap')!
          expect(
            [...glued.getClientRects()].filter((rect) => rect.width > 0),
            header.dataset.column
          ).toHaveLength(1)
          // At these widths every heading, "Download size" too, is one line.
          const lineHeight = parseFloat(getComputedStyle(sort).lineHeight)
          expect(
            sort.getBoundingClientRect().height,
            header.dataset.column
          ).toBeLessThan(lineHeight * 1.5)
        }
        for (const row of summaries()) {
          const cells = visibleCells(row)
          expect(cells).toHaveLength(headers.length)
          cells.forEach((cell, index) => {
            const header = headers[index].getBoundingClientRect()
            const box = cell.getBoundingClientRect()
            expect(
              box.left,
              `${row.dataset.modelRow} column ${index}`
            ).toBeCloseTo(header.left, 0)
            expect(box.width).toBeCloseTo(header.width, 0)
          })
          // The name keeps its heart, and a fit verdict stays in its column.
          expectFits(
            within(row).getByRole('button', { name: /^(Like|Unlike) / }),
            cells[0]
          )
          // A Hugging Face upload names its owner under the name, inside the cell.
          const owner = row.querySelector<HTMLElement>('.model-row-owner')
          if (row.dataset.source === 'huggingface') {
            expect(owner, row.dataset.modelRow).not.toBeNull()
            expectFits(owner!, cells[0])
          } else {
            expect(owner, row.dataset.modelRow).toBeNull()
          }
          for (const badge of within(row).queryAllByText(
            /^(Good fit|Might fit|Won’t fit)$/
          )) {
            expectFits(badge, badge.closest('td')!)
          }
        }
      })
    }

    it(`opens a row across the whole table, its facts in four columns (${label})`, async () => {
      setFontSize(size)
      renderTable(listWidth(1024), 'google/gemma-4-27b-it-qat-GGUF')
      await settle()

      const list = screen.getByTestId('list')
      expectNoHorizontalOverflow(list)
      const table = screen.getByRole('table').getBoundingClientRect()
      const open = screen.getByTestId('model-detail-panel')
      expect(open.closest('td')!.getBoundingClientRect().width).toBeCloseTo(
        table.width,
        0
      )
      const facts = open.querySelector('dl')!
      const tops = [...facts.children].map((fact) =>
        Math.round(fact.getBoundingClientRect().top)
      )
      expect(tops.filter((top) => top === tops[0])).toHaveLength(4)
      expectFits(within(open).getByRole('link', { name: /Hugging Face/ }), open)
    })
  }

  // The table answers to its own width: columns give way, the rest share it.
  // The steps are in em, so the widths follow the default font size (they
  // were measured at 16px).
  const fontScale = parseFloat(DEFAULT_FONT_SIZE) / 16
  for (const [width, columns] of [
    [1200, 7],
    [1000, 6],
    [800, 5],
    [600, 4],
    [480, 3],
  ].map(([at16, count]) => [Math.round(at16 * fontScale), count])) {
    it(`keeps ${columns} columns at ${width}px`, async () => {
      renderTable(width)
      await settle()

      expect(visibleColumns()).toHaveLength(columns)
      expectNoHorizontalOverflow(screen.getByTestId('list'))
    })
  }
})
