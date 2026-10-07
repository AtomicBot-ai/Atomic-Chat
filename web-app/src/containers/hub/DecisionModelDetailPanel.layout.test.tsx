import { act, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { describe, expect, it, vi } from 'vitest'

import type { DecisionModelState } from '@/hooks/useDecisionModel'
import { getBaselineDecisionCatalog } from '@/services/decision-catalog-registry'
import {
  expectNoHorizontalOverflow,
  expectOneLine,
  setFontSize,
  setTheme,
  settle,
} from '@/test/layout'

const state = vi.hoisted(() => ({ current: {} as DecisionModelState }))

vi.mock('@/hooks/useDecisionModel', () => ({
  useDecisionModel: () => state.current,
  useLocalDecisionModel: () => state.current,
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

import { DecisionModelDetailPanel } from './DecisionModelDetailPanel'

const model = getBaselineDecisionCatalog().models.find(
  (m) => m.id === 'julia-1'
)!

const modelState = (
  overrides: Partial<DecisionModelState>
): DecisionModelState => ({
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
  'the download box of a decision model, %s theme',
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
              <DecisionModelDetailPanel model={model} />
            </main>
          </div>
        )
        await settle(container)
        const row = screen.getByTestId(`decision-download-${model.id}`)
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
              <DecisionModelDetailPanel model={model} />
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
