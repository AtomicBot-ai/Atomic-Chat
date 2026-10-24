import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n/setup'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectOneLine,
  settle,
  setFontSize,
  setTheme,
  withTranslations,
} from '@/test/layout'
import { DownloadProgressRow } from './DownloadProgressRow'

for (const language of ['en', 'ko']) {
  for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
    for (const viewport of [1024, 1280]) {
      describe(`recovered download ${language} ${font} ${viewport}px`, () => {
        afterEach(async () => { await i18n.changeLanguage('en') })
        it('keeps an unresolved long-name row and its action inside the panel', async () => {
          await i18n.changeLanguage(language)
          setFontSize(font)
          setTheme('light')
          const status = i18n.t('common:downloadRecoveryNeedsSource')
          render(withTranslations(
            <div style={{ width: Math.min(352, viewport - 32) }} data-testid="recovery-panel">
              <ul>
                <DownloadProgressRow
                  id="AtomicChat/Qwen3_8-Flash-Next-AD-4_27bpw-Q4_K_M-M64/Qwen3_8-Flash-Next-AD-4_27bpw-Q4_K_M-M64"
                  progress={0}
                  current={12 * 1024 ** 3}
                  total={0}
                  paused
                  pausable={false}
                  statusText={status}
                  onCancel={() => {}}
                />
              </ul>
            </div>
          ))
          await act(async () => { await settle() })
          const panel = screen.getByTestId('recovery-panel')
          expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1)
          // The progress fill intentionally translates outside its clipping box.
          // Measure the header and status, where overflow would hide text/actions.
          expectNoHorizontalOverflow(panel.querySelector('li > div') as HTMLElement)
          expectNoHorizontalOverflow(screen.getByText(status))
          expectOneLine(screen.getByText(status))
        })
      })
    }
  }
}
