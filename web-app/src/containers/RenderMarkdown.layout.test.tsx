import { act, render, waitFor } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { describe, expect, it } from 'vitest'
import { RenderMarkdown } from './RenderMarkdown'
import { HtmlArtifact } from './HtmlArtifact'
import { CodeBlock } from '@/components/ai-elements/code-block'
import { Tool, ToolInput } from '@/components/ai-elements/tools/tool'
import {
  expectFits,
  expectNoHorizontalOverflow,
  expectVerticallyCentered,
  setFontSize,
  setTheme,
  settle,
} from '@/test/layout'

const path =
  String.raw`C:\Users\Danny\Documents\Atomic Chat\exports` +
  '\\nested-directory'.repeat(18) +
  '\\results.csv'
const source = `Get-Content -LiteralPath "${path}" | ConvertFrom-Csv\n\n    Write-Output "${'unbroken'.repeat(80)}"\nname,path,description\nDanny,"${path}","${'CSV field '.repeat(35)}"\nlast line`
const cases = [480, 1024, 1280].flatMap((width) =>
  ['16px', '20px'].flatMap((fontSize) =>
    (['light', 'dark'] as const).map((theme) => ({ width, fontSize, theme }))
  )
)

// Check ink, not just clipped element boxes: overflow:hidden alone must fail.
function expectWrappedCode(pre: HTMLElement) {
  const bounds = pre.getBoundingClientRect()
  const padding = parseFloat(getComputedStyle(pre).paddingLeft)
  expect(padding).toBeGreaterThanOrEqual(16)
  expect(getComputedStyle(pre).overflowX).not.toBe('auto')
  expect(pre.scrollWidth).toBeLessThanOrEqual(pre.clientWidth)
  const code = pre.querySelector('code')!
  expect(code.scrollWidth).toBeLessThanOrEqual(code.clientWidth)
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  const tops = new Set<number>()
  let first: DOMRect | undefined
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue
    const range = document.createRange()
    // pre-wrap preserves hanging spaces; measure visible glyphs separately.
    for (const match of node.textContent!.matchAll(/\S+/g)) {
      range.setStart(node, match.index!)
      range.setEnd(node, match.index! + match[0].length)
      for (const rect of range.getClientRects()) {
        if (!rect.width) continue
        first ??= rect
        tops.add(Math.round(rect.top))
        expect(rect.left).toBeGreaterThanOrEqual(bounds.left + padding - 1)
        expect(rect.right).toBeLessThanOrEqual(bounds.right - padding + 1)
        expect(rect.top).toBeGreaterThanOrEqual(bounds.top)
        expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom)
      }
    }
  }
  expect(first!.left - bounds.left).toBeGreaterThanOrEqual(padding)
  expect(tops.size).toBeGreaterThan(
    pre.textContent?.includes('Write-Output') ? source.split('\n').length : 3
  )
}

function visiblePre(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLPreElement>('pre')].filter(
    (pre) => pre.getBoundingClientRect().width > 0
  )
}

for (const surface of [
  'markdown',
  'markdown-preview',
  'shared',
  'tool',
] as const) {
  describe(`${surface} code wrapping (Chromium)`, () => {
    it.each(cases)(
      '$width / $fontSize / $theme: wraps every token inside padded bounds',
      async ({ width, fontSize, theme }) => {
        await page.viewport(width, 800)
        setFontSize(fontSize)
        setTheme(theme)
        const { container } = render(
          <div style={{ marginLeft: width >= 1024 ? 256 : 0, padding: 24 }}>
            {surface.startsWith('markdown') ? (
              <RenderMarkdown
                content={`\`\`\`powershell\n${source}\n\`\`\`\n\n\`\`\`csv\n${source}\n\`\`\``}
                enableHtmlPreview={surface === 'markdown-preview'}
                isAnimating={false}
              />
            ) : surface === 'shared' ? (
              <CodeBlock code={source} language="powershell" />
            ) : (
              <Tool state="input-available" open>
                <ToolInput input={{ path, content: source }} />
              </Tool>
            )}
          </div>
        )
        await waitFor(() => {
          expect(visiblePre(container).length).toBe(
            surface === 'shared' ? 1 : 2
          )
          expect(container.textContent).toContain('last line')
          expect(container.querySelector('code span[style]')).toBeTruthy()
        })
        await act(async () => {
          await settle(container)
        })
        for (const pre of visiblePre(container)) expectWrappedCode(pre)
        expectNoHorizontalOverflow(container)
        for (const header of container.querySelectorAll<HTMLElement>(
          '[data-streamdown="code-block-header"]'
        )) {
          const buttons = [...header.querySelectorAll('button')]
          expect(buttons).toHaveLength(2)
          for (const button of buttons) expectFits(button, header)
          expectVerticallyCentered(buttons[0], buttons[1])
          expect(header.textContent).toMatch(/powershell|csv/)
        }
        // Soft wrapping must leave selection and source text intact.
        const pre = visiblePre(container).at(-1)!
        const range = document.createRange()
        range.selectNodeContents(pre.querySelector('code')!)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        expect(selection.toString()).toContain('unbroken'.repeat(80))
        selection.removeAllRanges()
      }
    )
  })
}

describe('related chat code surfaces', () => {
  it.each(['light', 'dark'] as const)(
    'preserves numbered artifact lines and wrapping in %s mode',
    async (theme) => {
      await page.viewport(480, 800)
      setFontSize('20px')
      setTheme(theme)
      const { container } = render(
        <HtmlArtifact
          code={`<html>\n<body>\n<div data-path="${path}">${'token'.repeat(200)}</div>\n</body>\n</html>`}
          streaming
          showActions={false}
        />
      )
      await waitFor(() => expect(visiblePre(container)).toHaveLength(1))
      await act(async () => {
        await settle(container)
      })
      const pre = visiblePre(container)[0]
      expectWrappedCode(pre)
      const lines = [...pre.querySelectorAll<HTMLElement>('.line')]
      expect(lines).toHaveLength(5)
      expect(lines[0].textContent).toBe('1<html>')
      expect(lines[1].textContent).toBe('2<body>')
      // Numbered rows use display:block; literal newlines must not add blank rows.
      expect(lines[1].getBoundingClientRect().top).toBeCloseTo(
        lines[0].getBoundingClientRect().bottom,
        0
      )
      expectNoHorizontalOverflow(container)
    }
  )

  it('keeps vertical scrolling for long tool input without a horizontal scrollbar', async () => {
    await page.viewport(480, 800)
    setFontSize('20px')
    const { container } = render(
      <Tool state="input-available" open>
        <ToolInput
          input={{ content: source + '\nAnother source line'.repeat(20) }}
        />
      </Tool>
    )
    await waitFor(() =>
      expect(container.querySelector('pre code')).toBeTruthy()
    )
    await act(async () => {
      await settle(container)
    })
    const scroller = [...container.querySelectorAll<HTMLElement>('div')].find(
      (element) =>
        element.clientHeight > 0 &&
        element.scrollHeight > element.clientHeight &&
        getComputedStyle(element).overflowY === 'auto'
    )!
    expect(scroller).toBeTruthy()
    expect(getComputedStyle(scroller).overflowX).toBe('hidden')
    expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth)
    expectWrappedCode(visiblePre(container)[0])
  })
})
