import { render, screen, within } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { describe, expect, it } from 'vitest'

import i18n from '@/i18n/setup'
import {
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectOneLine,
  expectSameHeight,
  expectSameWidth,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'

import { DownloadPanel } from './DownloadPanel'
import type { DownloadRowProps } from './DownloadProgressRow'

const GB = 1024 ** 3
const MB = 1024 ** 2

// The worst case the panel meets: a long repo id, two-digit GB sizes, a
// three-digit percent with an estimate, a pause beside a running transfer.
const items: DownloadRowProps[] = [
  {
    id: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-1M-GGUF/Qwen3-Coder-30B-A3B-Instruct-1M-UD-Q4_K_XL.gguf',
    progress: 0.42,
    current: 7.81 * GB,
    total: 18.6 * GB,
    bytesPerSecond: 11.4 * MB,
    pausable: true,
  },
  {
    id: 'AtomicChat/Ornith-1_5-9B-AD-IQ4_XS',
    progress: 1,
    current: 12.4 * GB,
    total: 12.4 * GB,
    bytesPerSecond: 0,
    pausable: true,
    paused: true,
  },
  {
    id: 'llamacpp-backend-b6123-macos-arm64',
    progress: 0,
    current: 0,
    total: 0,
  },
]

describe.each(['light', 'dark'] as const)(
  'download panel in the %s theme',
  (theme) => {
    it.each(['en', 'ru'])(
      'keeps each strip to its lines and its controls in one column at Extra Large in %s',
      async (language) => {
        await page.viewport(1024, 768)
        setTheme(theme)
        setFontSize(XL_FONT_SIZE)
        await i18n.changeLanguage(language)
        render(withTranslations(<DownloadPanel items={items} />))

        const panel = screen.getByRole('region')
        await settle(panel)

        const rows = within(panel).getAllByRole('listitem')
        for (const row of rows) {
          const [name, line] = row.querySelectorAll<HTMLElement>('[data-testid="overflow-text-primary"]')
          expectOneLine(name)
          expectOneLine(line)
        }
        // The running transfer keeps its size; a cut line loses the estimate.
        expect(rows[0].querySelectorAll('[data-testid="overflow-text-primary"]')[1].textContent).toContain(
          '7.81 / 18.60 GB'
        )
        expect(within(rows[1]).getByText('100%')).toBeVisible()
        expectSameHeight(rows)
        // Pause and Resume hold the same slot: the cancel column lines up.
        expectSameWidth(
          [0, 1].map(
            (index) =>
              within(rows[index]).getByLabelText(
                i18n.t('common:cancelDownload')
              ).parentElement!
          )
        )
        expectNoHorizontalOverflow(panel)
        expectNoHorizontalOverflow(document.body)

        const box = panel.getBoundingClientRect()
        expect(box.right).toBeLessThanOrEqual(window.innerWidth)
        expect(box.bottom).toBeLessThanOrEqual(window.innerHeight)
        // The strip's colours, in the app's theme.
        const probe = document.createElement('div')
        probe.style.background = 'var(--background)'
        document.body.append(probe)
        expect(getComputedStyle(panel).backgroundColor).toBe(
          theme === 'dark'
            ? 'rgb(23, 33, 27)'
            : getComputedStyle(probe).backgroundColor
        )
        probe.remove()
      }
    )
  }
)
