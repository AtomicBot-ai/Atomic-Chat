import { render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { describe, expect, it } from 'vitest'
import { ModelListRow } from './ModelListRow'
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

describe('Downloaded Hub row geometry (Chromium)', () => {
  it.each(cases)(
    '$width / $fontSize / $theme keeps the marker visible with long names',
    async ({ width, fontSize, theme }) => {
      await page.viewport(width, 800)
      setFontSize(fontSize)
      setTheme(theme)
      render(
        withTranslations(
          <div data-testid="rows" style={{ marginLeft: 256, width: 320 }}>
            {[false, true].map((downloaded) => (
              <ModelListRow
                key={String(downloaded)}
                model={{
                  model_name:
                    'publisher/' +
                    'Qwen3.5-Experimental-Long-Model-'.repeat(15),
                  developer: 'publisher',
                  downloads: 1,
                }}
                downloaded={downloaded}
                selected={downloaded}
                onSelect={() => undefined}
              />
            ))}
          </div>
        )
      )
      await document.fonts.ready
      const rows = screen.getAllByRole('button')
      expectSameHeight(rows)
      expectNoHorizontalOverflow(screen.getByTestId('rows'))
      expectNoHorizontalOverflow(document.body)
      const marker = screen.getByRole('img', { name: 'Downloaded' })
      const markerBox = marker.getBoundingClientRect()
      const rowBox = rows[1].getBoundingClientRect()
      expect(markerBox.width).toBeGreaterThan(0)
      expect(markerBox.left).toBeGreaterThan(rowBox.left)
      expect(markerBox.right).toBeLessThan(rowBox.right)
      for (const row of rows) {
        const title = row.querySelector('.truncate') as HTMLElement
        expectOneLine(title)
        expect(title.scrollWidth).toBeGreaterThan(title.clientWidth)
      }
    }
  )
})
