import { render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { describe, expect, it } from 'vitest'
import { AgentNoToolsWarning } from './AgentNoToolsWarning'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import {
  expectNoHorizontalOverflow,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'

const cases = [1024, 1280].flatMap((width) =>
  ['16px', '20px'].flatMap((fontSize) =>
    (['light', 'dark'] as const).map((theme) => ({ width, fontSize, theme }))
  )
)

describe('Agent no-tool warning geometry (Chromium)', () => {
  it.each(cases)(
    '$width / $fontSize / $theme',
    async ({ width, fontSize, theme }) => {
      await page.viewport(width, 800)
      setFontSize(fontSize)
      setTheme(theme)
      useGeneralSetting.setState({ agentModeEnabled: true })
      render(
        withTranslations(
          <div style={{ marginLeft: 256, padding: 16 }}>
            <AgentNoToolsWarning allowFallback />
          </div>
        )
      )
      await settle()
      const card = screen.getByRole('status')
      const button = screen.getByRole('button', { name: 'Turn off Agent mode' })
      expectNoHorizontalOverflow(card)
      expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(
        card.getBoundingClientRect().right
      )
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)
      const b = button.getBoundingClientRect()
      expect(
        button.contains(
          document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
        )
      ).toBe(true)
    }
  )
})
