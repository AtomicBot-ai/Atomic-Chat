import { fireEvent, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ContextSizeControl } from './ContextSizeControl'
import { setFontSize, setTheme, settle, withTranslations } from '@/test/layout'

const state = vi.hoisted(() => ({ strata: false, managed: false }))
vi.mock('@/hooks/useServiceHub', async (load) => ({
  ...await load<typeof import('@/hooks/useServiceHub')>(), useServiceHub: () => ({}),
}))
vi.mock('@/hooks/useTokensCount', () => ({
  useTokensCount: () => ({
    tokenCount: 983,
    maxTokens: 16_384,
    isNearLimit: false,
    loading: false,
    calculateTokens: vi.fn(),
  }),
}))

vi.mock('@/hooks/useModelContextLength', () => ({
  formatContextSize: () => '16.0K',
  useModelContextLength: () => ({
    available: !state.strata,
    provider: state.managed ? {
      provider: 'vllm', settings: [{ key: 'context_length', controller_props: { value: 65536, min: 0, max: 1048576 } }],
    } : state.strata ? {
      provider: 'strata', settings: [{ key: 'context_length', controller_props: { value: 1048576, min: 0, max: 2147483647 } }],
    } : undefined,
    selectedModel: state.managed ? { id: 'qwen', contextLength: 20000 } : state.strata ? { id: 'deepseek', strata: { family: 'deepseek41', context_length: 8192 } } : undefined,
    strataMax: 1048576,
    contextSetting: {
      title: 'Context Size',
      description: 'Size of the prompt context (0 = loaded from model).',
    },
    draft: 16_384,
    setDraft: vi.fn(),
    commit: vi.fn(),
    sliderMin: 1_024,
    sliderMax: 262_144,
    sliderStep: 1_024,
    fitAvailable: true,
    fitEnabled: false,
    setFit: vi.fn(),
  }),
}))

function visibleLineCount(element: Element): number {
  const range = document.createRange()
  range.selectNodeContents(element)
  const tops = new Set(
    [...range.getClientRects()]
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => Math.round(rect.top))
  )
  range.detach()
  return tops.size
}

describe('context-size popover geometry', () => {
  beforeEach(() => {
    state.managed = false
    state.strata = false
    document.body.innerHTML = ''
  })

  it.each([[390, '20px'], [1024, '20px'], [1280, '13px']] as const)(
    'fits the managed checkpoint limit action at %ipx with %s type', async (width, font) => {
      state.managed = true
      await page.viewport(width, 800)
      setFontSize(font)
      render(withTranslations(<ContextSizeControl />))
      fireEvent.click(screen.getByRole('button', { name: /Context usage/ }))
      const panel = await screen.findByTestId('context-size-popover')
      await settle(panel)
      expect(screen.getByRole('button', { name: /Apply maximum of/ })).toBeVisible()
      expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1)
    }
  )

  it.each([[390, '20px'], [1024, '20px'], [1280, '13px']] as const)(
    'fits the Strata model maximum at %ipx with %s type', async (width, font) => {
      state.strata = true
      await page.viewport(width, 800)
      setFontSize(font)
      render(withTranslations(<ContextSizeControl />))
      fireEvent.click(screen.getByRole('button', { name: /Context usage/ }))
      const panel = await screen.findByTestId('context-size-popover')
      await settle(panel)
      expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1)
      expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', (1048576).toLocaleString())
    }
  )

  for (const width of [390, 1024]) {
    for (const font of ['16px', '20px']) {
      for (const theme of ['light', 'dark'] as const) {
        it(`${width}px / ${font} / ${theme}: readable fit copy without overflow`, async () => {
          await page.viewport(width, 800)
          setFontSize(font)
          setTheme(theme)
          render(
            withTranslations(
              <div style={{ position: 'fixed', top: 24, right: 24 }}>
                <ContextSizeControl />
              </div>
            )
          )
          fireEvent.click(
            screen.getByRole('button', { name: 'Context usage: 6.0%' })
          )
          const panel = await screen.findByTestId('context-size-popover')
          await settle(panel)

          const box = panel.getBoundingClientRect()
          expect(box.width).toBeLessThanOrEqual(384)
          expect(box.width).toBeGreaterThanOrEqual(Math.min(370, width - 32))
          expect(box.left).toBeGreaterThanOrEqual(16)
          expect(box.right).toBeLessThanOrEqual(width - 16)
          expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1)

          const description = screen.getByTestId('context-size-fit-description')
          expect(visibleLineCount(description)).toBeLessThanOrEqual(3)
          expect(getComputedStyle(description).fontSize).toBe(
            getComputedStyle(screen.getByText('Context Size')).fontSize
          )
        })
      }
    }
  }
})
