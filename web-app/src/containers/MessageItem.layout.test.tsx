import { act, fireEvent, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { MessageItem } from './MessageItem'
import {
  Conversation,
  ConversationContent,
} from '@/components/ai-elements/conversation'
import { useReasoningAutoScroll } from '@/hooks/useReasoningAutoScroll'
import { seedServiceHub } from '@/test/service-hub'
import {
  expectNoHorizontalOverflow,
  expectOneLine,
  expectVerticallyCentered,
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

async function prepare(
  testCase: (typeof cases)[number],
  text = longText,
  open = true
) {
  await page.viewport(testCase.width, 800)
  setFontSize(testCase.fontSize)
  setTheme(testCase.theme)
  const result = render(<Harness text={text} />)
  await act(async () => {
    await document.fonts.ready
    if (open) {
      fireEvent.click(
        result.container.querySelector('[data-slot="collapsible-trigger"]')!
      )
    }
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
  it.each(cases)(
    '$width / $fontSize / $theme: stable rows and adjacent chevrons through reasoning, tools, gaps and final',
    async ({ width, fontSize, theme }) => {
      await page.viewport(width, 800)
      setFontSize(fontSize)
      setTheme(theme)
      const thought: UIMessage['parts'][number] = {
        type: 'reasoning',
        text: 'Plan the lookup.',
        state: 'done',
      }
      const tool = (id: string, state: string, query: string) =>
        ({
          type: 'tool-web_search_exa',
          toolCallId: id,
          state,
          input: { query },
          ...(state === 'output-available' ? { output: [] } : {}),
        }) as UIMessage['parts'][number]
      const first = tool('first', 'output-available', 'first query')
      const second = tool('second', 'output-available', 'second query')
      const phases = [
        { parts: [thought], label: 'Working', active: true },
        {
          parts: [thought, tool('first', 'input-available', 'first query')],
          label: 'Searching',
          active: true,
        },
        { parts: [thought, first], label: 'Working', active: true },
        {
          parts: [
            thought,
            first,
            tool(
              'second',
              'input-streaming',
              'Ausführliche Untersuchung '.repeat(20)
            ),
          ],
          label: 'Searching',
          active: true,
        },
        { parts: [thought, first, second], label: 'Working', active: true },
        {
          parts: [thought, first, second],
          label: 'Completed 2 actions',
          active: false,
        },
      ]
      const item = (phase: (typeof phases)[number]) =>
        withTranslations(
          <div style={{ marginLeft: 256, padding: 24 }}>
            <MessageItem
              message={{
                id: 'lifecycle-layout',
                role: 'assistant',
                parts: phase.parts,
              }}
              isFirstMessage={false}
              isLastMessage
              status={phase.active ? 'streaming' : 'ready'}
              requestActive={phase.active}
              hideActions
            />
            <div data-testid="lifecycle-anchor">Answer position</div>
          </div>
        )
      const { container, rerender } = render(item(phases[0]))
      await act(async () => {
        await document.fonts.ready
        await frame()
        await frame()
      })
      const thinking = screen.getByRole('button', { name: /Thinking for/ })
      const activity = screen
        .getByTestId('tool-activity-group')
        .querySelector('button')!
      const anchor = screen
        .getByTestId('lifecycle-anchor')
        .getBoundingClientRect().top
      const rowHeight = activity.getBoundingClientRect().height
      for (const phase of phases) {
        rerender(item(phase))
        await act(async () => {
          await frame()
          await frame()
        })
        expect(activity).toHaveTextContent(phase.label)
        expect(activity).toBe(
          screen.getByTestId('tool-activity-group').querySelector('button')
        )
        expect(thinking).toBe(
          screen.getByRole('button', {
            name: phase.active ? /Thinking for/ : /Thought for/,
          })
        )
        expect(thinking.querySelector('.text-transparent')).toBeNull()
        expect(activity.getBoundingClientRect().height).toBeCloseTo(
          rowHeight,
          0
        )
        expect(
          screen.getByTestId('lifecycle-anchor').getBoundingClientRect().top
        ).toBeCloseTo(anchor, 0)
        expect(viewport(container).getBoundingClientRect().height).toBe(0)

        for (const trigger of [thinking, activity]) {
          const chevron = trigger.querySelector(
            '.lucide-chevron-down, .lucide-chevron-right'
          )
          if (!chevron) continue // No disclosure before the first tool exists.
          const summary = chevron.previousElementSibling as HTMLElement
          const gap = parseFloat(
            getComputedStyle(chevron.parentElement!).columnGap
          )
          expect(
            chevron.getBoundingClientRect().left -
              summary.getBoundingClientRect().right
          ).toBeCloseTo(gap, 0)
          expectVerticallyCentered(chevron, summary)
          const textElement =
            (summary.firstElementChild as HTMLElement | null) ?? summary
          expectOneLine(textElement)
          if (textElement.scrollWidth <= textElement.clientWidth) {
            const text = document.createRange()
            text.selectNodeContents(textElement)
            expect(
              chevron.getBoundingClientRect().left -
                text.getBoundingClientRect().right
            ).toBeCloseTo(gap, 0)
          }
        }
        expectNoHorizontalOverflow(container)
      }
      expect(screen.getAllByText('Completed 2 actions')).toHaveLength(1)
      expect(
        screen.getAllByRole('button', { name: /Thought for/ })
      ).toHaveLength(1)
    }
  )

  it('keeps reasoning and activity chevrons immediately beside their summaries', async () => {
    await page.viewport(1024, 800)
    setFontSize('20px')
    const { container } = render(
      withTranslations(
        <div className="w-[720px] p-6">
          <MessageItem
            message={{
              id: 'adjacent-chevrons',
              role: 'assistant',
              parts: [
                {
                  type: 'reasoning',
                  text: 'Plan the lookup.',
                  state: 'done',
                },
                {
                  type: 'tool-mcp.search',
                  toolCallId: 'search-1',
                  state: 'output-available',
                  input: { query: 'layout' },
                  output: { ok: true },
                },
              ],
            }}
            isFirstMessage={false}
            isLastMessage
            status="ready"
            hideActions
          />
        </div>
      )
    )
    await act(async () => {
      await document.fonts.ready
      await frame()
      await frame()
    })

    for (const selector of ['.lucide-chevron-down', '.lucide-chevron-right']) {
      const chevron = container.querySelector<SVGElement>(selector)!
      const summary = chevron.previousElementSibling as HTMLElement
      const wrapper = chevron.parentElement!
      const trigger = wrapper.parentElement!
      const summaryBox = summary.getBoundingClientRect()
      const chevronBox = chevron.getBoundingClientRect()
      const triggerBox = trigger.getBoundingClientRect()
      const gap = parseFloat(getComputedStyle(wrapper).columnGap)

      expect(chevronBox.left - summaryBox.right).toBeCloseTo(gap, 0)
      expect(triggerBox.right - chevronBox.right).toBeGreaterThan(100)
    }
    expectNoHorizontalOverflow(container)
  })

  it('starts as one compact closed status row', async () => {
    const result = await prepare(cases[0], longText, false)
    const panel = viewport(result.container)

    expect(panel.getBoundingClientRect().height).toBe(0)
    expect(
      result.container.querySelector('[data-slot="collapsible-trigger"]')
    ).toHaveAttribute('aria-expanded', 'false')
  })

  it.each(cases)(
    '$width / $fontSize / $theme: closed reasoning stays compact during token growth',
    async (testCase) => {
      const { container, rerender, panel } = await prepare(
        testCase,
        'First short line.',
        false
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
        expect(panel.getBoundingClientRect().height).toBe(0)
        expect(
          screen.getByTestId('end').getBoundingClientRect().bottom
        ).toBeCloseTo(anchor, 0)
        expectNoHorizontalOverflow(container)
      }
      fireEvent.click(
        container.querySelector('[data-slot="collapsible-trigger"]')!
      )
      await act(async () => {
        await frame()
        await frame()
      })
      expect(panel.getBoundingClientRect().height).toBeGreaterThan(1000)
      expect(
        panel.querySelector('[data-streaming-reasoning]')!.textContent
      ).toContain('Final visible tail')
      expectNoHorizontalOverflow(container)
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
      expect(panel.getBoundingClientRect().height).toBeGreaterThan(0)
      expect(panel.scrollHeight).toBeLessThanOrEqual(panel.clientHeight + 1)
      expect(panel.querySelector('[data-streamdown="strong"]')).not.toBeNull()
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
