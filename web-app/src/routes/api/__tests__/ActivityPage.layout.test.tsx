import { act, render } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useApiServerLog } from '@/hooks/useApiServerLog'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectFits,
  expectNoHorizontalOverflow,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'
import type { ApiRequestEntry } from '@/types/apiServerLog'

import { ApiActivityPage } from '../activity'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: unknown) => config,
}))

vi.mock('@/hooks/useLocalApiServerControl', () => ({
  useLocalApiServerControl: () => ({
    status: 'running',
    isRunning: true,
    isBusy: false,
    refreshStatus: vi.fn(),
  }),
}))

// The real feed listens to Tauri events; the log store is seeded instead.
vi.mock('@/hooks/useApiServerLogFeed', () => ({
  useApiServerLogFeed: () => ({ clear: vi.fn(), hydrate: vi.fn() }),
}))
vi.mock('@/hooks/useApiServerModelNotices', () => ({
  useApiServerModelNotices: () => {},
}))
vi.mock('@/utils/apiServerCapacity', () => ({
  getModelContextLength: () => 131072,
}))

// A worst-case id and the previews a watched chat request carries.
const LONG_MODEL = 'unsloth/' + 'VeryLongModelName'.repeat(6) + '-Q4_K_M'

function request(id: string, endpoint: string): ApiRequestEntry {
  return {
    kind: 'request',
    id,
    seq: 0,
    startedAt: Date.now(),
    status: 'completed',
    method: 'POST',
    endpoint,
    model: LONG_MODEL,
    stream: true,
    durationMs: 12_480,
    ttftMs: 640,
    promptTokens: 12_345,
    completionTokens: 1_024,
    totalTokens: 13_369,
    promptPreview: 'Summarize the attached release notes in three bullets.',
    replyPreview: 'The release adds remote media providers and fixes.',
  }
}

/** The page column beside the 60 px rail and the 256 px sidebar. */
function Shell() {
  return withTranslations(
    <div className="flex w-full">
      <aside className="w-[316px] shrink-0">Sidebar</aside>
      <main className="min-w-0 flex-1">
        <ApiActivityPage />
      </main>
    </div>
  )
}

/** The search field, the list it heads, and the region holding both panes. */
function panes(container: HTMLElement) {
  const search = container.querySelector('input') as HTMLInputElement
  const list = search.closest('.rounded-lg.border') as HTMLElement
  const region = list.closest('.gap-3') as HTMLElement
  return { search, list, region }
}

/** The placeholder's set width, measured with the field's own font. */
function placeholderWidth(input: HTMLInputElement): number {
  const style = getComputedStyle(input)
  const context = document.createElement('canvas').getContext('2d')!
  context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  return context.measureText(input.placeholder).width
}

function expectPlaceholderLegible(input: HTMLInputElement) {
  const style = getComputedStyle(input)
  const room =
    input.clientWidth -
    parseFloat(style.paddingLeft) -
    parseFloat(style.paddingRight)
  const needs = placeholderWidth(input)
  expect(
    needs,
    `"${input.placeholder}" needs ${needs.toFixed(1)} px; the field has ${room.toFixed(1)}`
  ).toBeLessThanOrEqual(room)
}

const box = (el: Element) => el.getBoundingClientRect()

beforeEach(() => {
  useApiServerLog.getState().reset()
  useApiServerLog.getState().hydrate([])
})

describe.each(['light', 'dark'] as const)(
  'Server → Activity, %s theme',
  (theme) => {
    // 1024 px with the sidebar open is the app's minimum window. The list and
    // the details sit side by side only where both have room: 1280 px at
    // Medium; Extra Large stacks there too.
    const cases = [1024, 1280].flatMap((width) =>
      [DEFAULT_FONT_SIZE, XL_FONT_SIZE].map((fontSize) => ({
        width,
        fontSize,
        stacked: width === 1024 || fontSize === XL_FONT_SIZE,
      }))
    )

    it.each(cases)(
      'keeps the search legible and holds no empty details column at $width px / $fontSize',
      async ({ width, fontSize, stacked }) => {
        await page.viewport(width, 740)
        setTheme(theme)
        setFontSize(fontSize)
        const { container } = render(<Shell />)
        // The page measures itself through a ResizeObserver; let it answer
        // inside act.
        await act(() => settle(container))

        const { search, list, region } = panes(container)
        expectPlaceholderLegible(search)
        expectNoHorizontalOverflow(region)

        if (stacked) {
          // No request, so nothing to inspect: the list has the whole width.
          expect(box(list).width).toBeCloseTo(box(region).width, 0)
          expect(region.textContent).not.toContain('Select a request')
        } else {
          expect(box(list).width).toBeLessThanOrEqual(380.5)
          const details = region.children[1] as HTMLElement
          expect(box(details).left).toBeGreaterThan(box(list).right)
        }
      }
    )

    it.each(cases)(
      'shows a selected request under or beside the list at $width px / $fontSize',
      async ({ width, fontSize, stacked }) => {
        await page.viewport(width, 740)
        setTheme(theme)
        setFontSize(fontSize)
        const { container } = render(<Shell />)
        act(() => {
          useApiServerLog.getState().applyBatch([
            { t: 'start', entry: request('b', 'embeddings') },
            { t: 'start', entry: request('a', 'chat/completions') },
          ])
        })
        // The page measures itself through a ResizeObserver; let it answer
        // inside act.
        await act(() => settle(container))

        const { search, list, region } = panes(container)
        expectPlaceholderLegible(search)
        expectNoHorizontalOverflow(region)
        // The first request is selected on arrival; its details are shown.
        const details = region.children[1] as HTMLElement
        expect(details.textContent).toContain('/chat/completions')
        expectFits(details, region)
        expect(box(details).height).toBeCloseTo(box(list).height, 0)

        if (stacked) {
          expect(box(details).top).toBeGreaterThan(box(list).bottom)
          expect(box(list).width).toBeCloseTo(box(region).width, 0)
          expect(box(details).width).toBeCloseTo(box(region).width, 0)
        } else {
          expect(box(details).top).toBeCloseTo(box(list).top, 0)
          expect(box(details).left).toBeGreaterThan(box(list).right)
        }
      }
    )
  }
)
