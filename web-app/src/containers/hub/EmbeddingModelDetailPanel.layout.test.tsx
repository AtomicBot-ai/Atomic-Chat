import { act, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { describe, expect, it, vi } from 'vitest'

import type { EmbeddingModelState } from '@/hooks/useEmbeddingModel'
import { getBaselineEmbeddingCatalog } from '@/services/embedding-catalog-registry'
import {
  expectNoHorizontalOverflow,
  expectOneLine,
  setFontSize,
  setTheme,
  settle,
} from '@/test/layout'

const state = vi.hoisted(() => ({ current: {} as EmbeddingModelState }))

vi.mock('@/hooks/useEmbeddingModel', () => ({
  useEmbeddingModel: () => state.current,
  useLocalEmbeddingModel: () => state.current,
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({}),
  getServiceHub: () => ({}),
}))
vi.mock('@/containers/hub/HubReadme', () => ({ HubReadme: () => null }))

import { EmbeddingModelDetailPanel } from './EmbeddingModelDetailPanel'

const model = getBaselineEmbeddingCatalog().models.find(
  (m) => m.id === 'embeddinggemma-2'
)!

const modelState = (
  overrides: Partial<EmbeddingModelState>
): EmbeddingModelState => ({
  active: false,
  running: false,
  state: null,
  busy: false,
  activate: async () => true,
  stop: async () => true,
  installed: false,
  downloading: false,
  progress: 0,
  currentBytes: 0,
  totalBytes: 865_000_000,
  download: async () => {},
  cancelDownload: () => {},
  remove: async () => true,
  ...overrides,
})

describe.each(['light', 'dark'] as const)(
  'the download box of an embedding model, %s theme',
  (theme) => {
    it.each(
      [1024, 1280].flatMap((width) =>
        ['16px', '18px', '20px'].map((fontSize) => ({ width, fontSize }))
      )
    )(
      'keeps its height when a download starts at $width px / $fontSize',
      async ({ width, fontSize }) => {
        await page.viewport(width, 900)
        setTheme(theme)
        setFontSize(fontSize)
        state.current = modelState({})
        const { container, rerender } = render(
          <div className="flex w-full">
            <aside className="w-64 shrink-0">Sidebar</aside>
            <main className="min-w-0 flex-1">
              <EmbeddingModelDetailPanel model={model} />
            </main>
          </div>
        )
        await settle(container)
        const row = screen.getByTestId(`embedding-download-${model.id}`)
        const box = row.parentElement as HTMLElement
        const before = box.getBoundingClientRect().height

        act(() => {
          state.current = modelState({
            downloading: true,
            progress: 0.39,
            currentBytes: 323_000_000,
          })
        })
        rerender(
          <div className="flex w-full">
            <aside className="w-64 shrink-0">Sidebar</aside>
            <main className="min-w-0 flex-1">
              <EmbeddingModelDetailPanel model={model} />
            </main>
          </div>
        )
        await settle(container)

        expect(box.getBoundingClientRect().height).toBeCloseTo(before, 0)
        expectNoHorizontalOverflow(box)
        // The bytes read out where the size was, on one line.
        expectOneLine(row.firstElementChild?.lastElementChild as HTMLElement)
      }
    )
  }
)
