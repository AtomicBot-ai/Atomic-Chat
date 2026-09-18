import { act, fireEvent, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageItem } from './MessageItem'
import {
  Conversation,
  ConversationContent,
} from '@/components/ai-elements/conversation'
import { useReasoningAutoScroll } from '@/hooks/useReasoningAutoScroll'
import { seedServiceHub } from '@/test/service-hub'
import {
  expectNoHorizontalOverflow,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: (s: unknown) => unknown) =>
    selector({ selectedModel: { id: 'test-model' } }),
}))

beforeEach(() => seedServiceHub())

const longText =
  '**Original reasoning**\n\n' +
  'Compare the options carefully before deciding.\n'.repeat(180)
const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

function Harness({
  text,
  streaming = true,
}: {
  text: string
  streaming?: boolean
}) {
  const { containerRef, onScroll } = useReasoningAutoScroll(streaming, text)
  return withTranslations(
    <div style={{ marginLeft: 256, padding: 24 }}>
      <Conversation className="h-[600px]">
        <ConversationContent>
          <div style={{ height: 1100, flexShrink: 0 }} data-testid="history">
            Earlier conversation
          </div>
          <div data-testid="prompt">Explain the options.</div>
          <MessageItem
            message={{
              id: 'live',
              role: 'assistant',
              parts: [
                {
                  type: 'reasoning',
                  text,
                  state: streaming ? 'streaming' : 'done',
                },
                ...(!streaming
                  ? [{ type: 'text' as const, text: 'The final answer.' }]
                  : []),
              ],
            }}
            isFirstMessage={false}
            isLastMessage
            status={streaming ? 'streaming' : 'ready'}
            reasoningContainerRef={containerRef}
            onReasoningScroll={onScroll}
            hideActions
          />
          <div data-testid="end" style={{ height: 24, flexShrink: 0 }} />
        </ConversationContent>
      </Conversation>
    </div>
  )
}

const cases = [1024, 1280].flatMap((width) =>
  ['16px', '20px'].flatMap((fontSize) =>
    (['light', 'dark'] as const).map((theme) => ({ width, fontSize, theme }))
  )
)

function viewport(container: HTMLElement) {
  // Locate the existing production viewport too, so the red test measures
  // the regression before the new state attributes exist.
  return container.querySelector<HTMLElement>(
    '[data-slot="collapsible-content"]'
  )!.parentElement!
}

async function prepare(testCase: (typeof cases)[number], text = longText) {
  await page.viewport(testCase.width, 800)
  setFontSize(testCase.fontSize)
  setTheme(testCase.theme)
  const result = render(<Harness text={text} />)
  await act(async () => {
    await document.fonts.ready
    fireEvent.click(
      result.container.querySelector('[data-slot="collapsible-trigger"]')!
    )
    await frame()
    const outer = screen.getByTestId('history').parentElement!.parentElement!
    const deadline = performance.now() + 3000
    while (
      outer.scrollHeight - outer.clientHeight - outer.scrollTop > 1 &&
      performance.now() < deadline
    ) {
      await frame()
    }
    expect(
      outer.scrollHeight - outer.clientHeight - outer.scrollTop
    ).toBeLessThanOrEqual(1)
    await frame()
  })
  return { ...result, panel: viewport(result.container) }
}

describe('Live reasoning geometry (Chromium)', () => {
  it('starts as one compact closed status row', async () => {
    await page.viewport(1024, 800)
    const result = render(<Harness text={longText} />)
    await settle()
    const panel = viewport(result.container)

    expect(panel.getBoundingClientRect().height).toBe(0)
    expect(
      result.container.querySelector('[data-slot="collapsible-trigger"]')
    ).toHaveAttribute('aria-expanded', 'false')
  })

  it.each(cases)(
    '$width / $fontSize / $theme: reserves height and follows fully visible tail lines',
    async (testCase) => {
      const { container, rerender, panel } = await prepare(
        testCase,
        'First short line.'
      )
      const initialHeight = panel.getBoundingClientRect().height
      const anchor = screen.getByTestId('end').getBoundingClientRect().bottom
      for (const text of [
        longText,
        longText + 'x'.repeat(700),
        longText + 'x'.repeat(700) + '\nFinal visible tail',
      ]) {
        rerender(<Harness text={text} />)
        await act(async () => {
          await frame()
          await frame()
          await frame()
        })
        expect(panel.getBoundingClientRect().height).toBeCloseTo(
          initialHeight,
          0
        )
        expect(panel.getBoundingClientRect().height).toBeLessThanOrEqual(180)
        expect(
          panel.scrollHeight - panel.clientHeight - panel.scrollTop
        ).toBeLessThanOrEqual(1)
        expect(
          screen.getByTestId('end').getBoundingClientRect().bottom
        ).toBeCloseTo(anchor, 0)
        expectNoHorizontalOverflow(container)
      }
      const tail = panel.querySelector(
        '[data-streaming-reasoning]'
      )!.firstChild!
      const range = document.createRange()
      range.setStart(
        tail,
        tail.textContent!.length - 'Final visible tail'.length
      )
      range.setEnd(tail, tail.textContent!.length)
      const ink = range.getBoundingClientRect()
      expect(ink.bottom).toBeLessThanOrEqual(
        panel.getBoundingClientRect().bottom - 4
      )
      expect(ink.top).toBeGreaterThan(panel.getBoundingClientRect().top)
      expect(panel.getAttribute('data-overflow-bottom')).toBe('false')

      panel.scrollTop -= 80
      fireEvent.scroll(panel)
      await frame()
      const readerTop = panel.scrollTop
      expect(panel.getAttribute('data-overflow-bottom')).toBe('true')
      expect(getComputedStyle(panel).maskImage).toContain('100%')
      rerender(
        <Harness
          text={
            longText + 'x'.repeat(700) + '\nFinal visible tail\nMore tokens'
          }
        />
      )
      await act(async () => {
        await frame()
        await frame()
      })
      expect(panel.scrollTop).toBe(readerTop)
    }
  )

  it.each(cases)(
    '$width / $fontSize / $theme: finishing preserves an explicitly opened trace without jolting the bottom anchor',
    async (testCase) => {
      const { container, rerender, panel } = await prepare(testCase)
      const liveHeight = panel.getBoundingClientRect().height
      const end = screen.getByTestId('end')
      const anchor = end.getBoundingClientRect().bottom
      const samples: Array<{ height: number; anchor: number }> = []
      const sample = () =>
        samples.push({
          height: panel.getBoundingClientRect().height,
          anchor: end.getBoundingClientRect().bottom,
        })
      rerender(<Harness text={longText} streaming={false} />)
      sample()
      await act(async () => {
        for (let i = 0; i < 24; i++) {
          await frame()
          sample()
        }
      })
      expect(Math.max(...samples.map((s) => s.height))).toBeLessThanOrEqual(
        liveHeight + 1
      )
      // Allow the first frame's newly inserted answer; never a trace-sized excursion.
      expect(
        Math.max(...samples.map((s) => Math.abs(s.anchor - anchor)))
      ).toBeLessThan(60)
      expect(panel.getBoundingClientRect().height).toBeCloseTo(liveHeight, 0)
      expect(end.getBoundingClientRect().bottom).toBeCloseTo(anchor, 0)
      expect(screen.getByText('The final answer.')).toBeTruthy()
      expect(
        container
          .querySelector('[data-slot="collapsible-trigger"]')!
          .getAttribute('aria-expanded')
      ).toBe('true')
      expectNoHorizontalOverflow(container)

      fireEvent.click(
        container.querySelector('[data-slot="collapsible-trigger"]')!
      )
      await act(async () => {
        await settle()
      })
      expect(panel.getBoundingClientRect().height).toBe(0)
      fireEvent.click(
        container.querySelector('[data-slot="collapsible-trigger"]')!
      )
      await act(async () => {
        await settle()
      })
      expect(panel.getBoundingClientRect().height).toBeGreaterThan(
        liveHeight * 2
      )
      expect(screen.getByText('Original reasoning')).toBeTruthy()
      expectNoHorizontalOverflow(container)
    }
  )

  it('keeps a scrolled-back conversation anchored during token growth and finish', async () => {
    const { container, rerender } = await prepare(cases[0])
    const history = screen.getByTestId('history')
    const outer = history.parentElement!.parentElement!
    await act(async () => {
      outer.scrollTop = 100
      fireEvent.scroll(outer)
      await frame()
    })
    const anchor = history.getBoundingClientRect().top
    rerender(<Harness text={longText + 'Extra tokens.\n'.repeat(80)} />)
    await act(async () => {
      await frame()
      await frame()
    })
    expect(history.getBoundingClientRect().top).toBe(anchor)
    rerender(<Harness text={longText} streaming={false} />)
    await act(async () => {
      await settle()
    })
    expect(history.getBoundingClientRect().top).toBe(anchor)
    expectNoHorizontalOverflow(container)
  })
})
