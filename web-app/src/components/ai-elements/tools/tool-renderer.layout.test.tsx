import { render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { describe, expect, it } from 'vitest'
import { ToolRenderer } from './tool-renderer'
import {
  expectNoHorizontalOverflow,
  expectOneLine,
  expectSameHeight,
  setFontSize,
  setTheme,
  withTranslations,
} from '@/test/layout'

const cases = [1024, 1280].flatMap((width) =>
  ['16px', '20px'].flatMap((fontSize) =>
    (['light', 'dark'] as const).map((theme) => ({ width, fontSize, theme }))
  )
)

describe('Tool activity geometry (Chromium)', () => {
  it.each(cases)(
    '$width / $fontSize / $theme truncates long activity labels',
    async ({ width, fontSize, theme }) => {
      await page.viewport(width, 800)
      setFontSize(fontSize)
      setTheme(theme)
      const title =
        'Sehr ausführliche Beschreibung einer Werkzeugaktion '.repeat(20)
      render(
        withTranslations(
          <div data-testid="activity" style={{ marginLeft: 256, padding: 24 }}>
            {(
              ['input-available', 'output-available', 'output-error'] as const
            ).map((state) => (
              <ToolRenderer
                key={state}
                state={state}
                toolName={'vendor.' + 'long_tool_name_'.repeat(70)}
                presentation={{
                  kind: 'generic',
                  title,
                  subtitle:
                    '/Users/atomic/Desktop/' + 'long-file-'.repeat(50) + '.txt',
                  errorText: 'Failure /Users/atomic/private.txt',
                }}
              />
            ))}
            <ToolRenderer
              state="output-available"
              toolName="os.fs.write"
              presentation={{
                kind: 'generic',
                title: 'Wrote file',
                input: {
                  path:
                    '/Users/atomic/Desktop/' + 'long-file-'.repeat(50) + '.txt',
                },
              }}
            />
          </div>
        )
      )
      await document.fonts.ready
      const rows = screen.getAllByRole('button')
      expectNoHorizontalOverflow(screen.getByTestId('activity'))
      expectNoHorizontalOverflow(document.body)
      expectSameHeight(rows)
      for (const row of rows) {
        const label = row.querySelector('span')!
        expectOneLine(label)
        expect(label.scrollWidth).toBeGreaterThan(label.clientWidth)
        expect(getComputedStyle(label).textOverflow).toBe('ellipsis')
        expect(row).toHaveAttribute('aria-label', label.textContent)
      }
    }
  )
})
