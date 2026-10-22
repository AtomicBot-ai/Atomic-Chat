import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n/setup'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
  expectNoHorizontalOverflow,
} from '@/test/layout'
import { AssistantMessageClockSettings } from './AssistantMessageClockSettings'

afterEach(async () => {
  await i18n.changeLanguage('en')
  setFontSize(DEFAULT_FONT_SIZE)
  setTheme('light')
})
for (const language of ['en', 'ko']) {
  for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
    for (const theme of ['light', 'dark'] as const) {
      describe(`${language} ${font} ${theme}`, () => {
        it('keeps both switches visible in a narrow settings column', async () => {
          await i18n.changeLanguage(language)
          setFontSize(font)
          setTheme(theme)
          render(
            withTranslations(
              <div data-testid="clock" style={{ width: 256 }}>
                <AssistantMessageClockSettings
                  includeDate
                  includeTime
                  onDateChange={vi.fn()}
                  onTimeChange={vi.fn()}
                />
              </div>
            )
          )
          await settle()
          const root = screen.getByTestId('clock')
          expectNoHorizontalOverflow(root)
          const switches = screen.getAllByRole('switch')
          expect(switches).toHaveLength(2)
          for (const control of switches) {
            const box = control.getBoundingClientRect()
            expect(box.width).toBeGreaterThan(20)
            expect(box.right).toBeLessThanOrEqual(
              root.getBoundingClientRect().right + 1
            )
          }
        })
      })
    }
  }
}
