import { render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  setFontSize,
  settle,
} from '@/test/layout'

import { ServerPage } from './ServerPageParts'

// The page column beside the 60 px rail and the 256 px sidebar, as in the app.
async function renderInColumn(width: number, children: React.ReactNode) {
  await page.viewport(width, 900)
  const { container } = render(
    <div className="flex w-full">
      <aside className="w-[316px] shrink-0">Sidebar</aside>
      <main data-testid="column" className="min-w-0 flex-1">
        {children}
      </main>
    </div>
  )
  await settle(container)
  const column = screen.getByTestId('column')
  // ServerPage's scroll area pads its content by 16 px on each side.
  const area = column.querySelector<HTMLElement>('.overflow-y-auto')!
  const box = area.getBoundingClientRect()
  const inner = { left: box.left + 16, right: box.right - 16 }
  return { column, inner }
}

const cards = (count: number) => (
  <div className="sp-tools-grid">
    {Array.from({ length: count }, (_, i) => (
      <article key={i} className="sp-tool" data-testid="card">
        <h3>Agent {i}</h3>
        <p>An agent that works with the local server.</p>
      </article>
    ))}
  </div>
)

const columnsIn = (elements: HTMLElement[]) =>
  new Set(elements.map((el) => Math.round(el.getBoundingClientRect().left)))
    .size

describe('Server pages on a wide window', () => {
  afterEach(() => setFontSize(DEFAULT_FONT_SIZE))

  it.each(
    [1280, 1920, 2560].flatMap((width) =>
      [DEFAULT_FONT_SIZE, XL_FONT_SIZE].map((fontSize) => ({
        width,
        fontSize,
      }))
    )
  )(
    'Overview fills the page and its cards take the width ($width px / $fontSize)',
    async ({ width, fontSize }) => {
      setFontSize(fontSize)
      const { column, inner } = await renderInColumn(
        width,
        <ServerPage layout="wide">{cards(26)}</ServerPage>
      )

      const content = column.querySelector('.server-page')!
      const box = content.getBoundingClientRect()
      expect(box.left).toBeCloseTo(inner.left, 0)
      expect(box.right).toBeCloseTo(inner.right, 0)
      const grid = column
        .querySelector('.sp-tools-grid')!
        .getBoundingClientRect()
      expect(grid.right).toBeCloseTo(inner.right, 0)
      // Cards never fall under their 230 px minimum, and a wider page adds
      // columns instead of leaving the right side empty.
      const all = screen.getAllByTestId('card')
      const columns = columnsIn(all)
      expect(all[0].getBoundingClientRect().width).toBeGreaterThanOrEqual(230)
      expect(columns).toBe(
        Math.floor((inner.right - inner.left + 16) / (230 + 16))
      )
      expectNoHorizontalOverflow(column)
    }
  )

  it.each([1280, 1920, 2560])(
    'Activity fills the page as well (%i px)',
    async (width) => {
      const { column, inner } = await renderInColumn(
        width,
        <ServerPage layout="dashboard" title="Activity">
          <div data-testid="dashboard" className="h-20 w-full" />
        </ServerPage>
      )

      const box = screen.getByTestId('dashboard').getBoundingClientRect()
      expect(box.left).toBeCloseTo(inner.left, 0)
      expect(box.right).toBeCloseTo(inner.right, 0)
      expectNoHorizontalOverflow(column)
    }
  )

  it.each([1024, 1280, 1920, 2560])(
    'a form page takes the whole page too, its title where Overview and Activity start (%i px)',
    async (width) => {
      const { column, inner } = await renderInColumn(
        width,
        <ServerPage title="Engine & model">
          <section className="sp-panel" data-testid="panel" />
        </ServerPage>
      )

      const panel = screen.getByTestId('panel').getBoundingClientRect()
      expect(panel.left).toBeCloseTo(inner.left, 0)
      expect(panel.right).toBeCloseTo(inner.right, 0)
      const title = screen
        .getByRole('heading', { name: 'Engine & model' })
        .getBoundingClientRect()
      expect(title.left).toBeCloseTo(inner.left, 0)
      expectNoHorizontalOverflow(column)
    }
  )
})
