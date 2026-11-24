import { fireEvent, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { afterEach, describe, expect, it } from 'vitest'

import { CompactionDivider } from './CompactionDivider'
import i18n from '@/i18n/setup'
import type { ThreadCompaction } from '@/lib/context-compaction'
import {
  expectNoHorizontalOverflow,
  expectOneLine,
  expectVerticallyCentered,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'

const compaction: ThreadCompaction = {
  summary: `The user is planning a two-week rail trip through Portugal and Spain. ${'They prefer night trains and small towns. '.repeat(12)}`,
  upToMessageId: 'u40',
  summarizedCount: 87,
  tokensBefore: 131_072,
  tokensAfter: 6_144,
  modelId: 'qwen',
  provider: 'vllm',
  createdAt: 1,
}

describe('compaction divider geometry', () => {
  const language = i18n.language
  afterEach(() => {
    i18n.language = language
    document.body.innerHTML = ''
  })

  for (const width of [390, 1024]) {
    for (const font of ['13px', '20px']) {
      for (const lng of ['en', 'ru']) {
        it(`${width}px / ${font} / ${lng}: one line, the action in reach`, async () => {
          await page.viewport(width, 800)
          setFontSize(font)
          setTheme(lng === 'ru' ? 'dark' : 'light')
          i18n.language = lng
          render(
            withTranslations(
              // The conversation column the divider sits in.
              <div className="mx-auto w-full max-w-3xl md:w-4/5 xl:w-4/6">
                <CompactionDivider compaction={compaction} />
              </div>
            )
          )
          const divider = screen.getByTestId('compaction-divider')
          await settle(divider)

          const label = screen.getByTestId('compaction-divider-label')
          const toggle = screen.getByRole('button')
          expectOneLine(label)
          expectOneLine(toggle.querySelector('span')!)
          expectVerticallyCentered(label, toggle)
          expectNoHorizontalOverflow(divider)

          fireEvent.click(toggle)
          await settle(divider)
          expectNoHorizontalOverflow(divider)
          expect(divider.getBoundingClientRect().height).toBeLessThan(
            // The summary scrolls inside its own region.
            parseFloat(getComputedStyle(document.documentElement).fontSize) * 40
          )
        })
      }
    }
  }
})
