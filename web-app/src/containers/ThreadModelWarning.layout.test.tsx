import { render, screen } from '@testing-library/react'
import { describe, it } from 'vitest'
import { ThreadModelWarning } from './ThreadModelWarning'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  setFontSize,
  settle,
  withTranslations,
} from '@/test/layout'

describe('unavailable saved model warning', () => {
  for (const width of [480, 700])
    for (const size of [DEFAULT_FONT_SIZE, XL_FONT_SIZE])
      for (const theme of ['light', 'dark']) {
        it(`fits ${width}px at ${size} in ${theme}`, async () => {
          setFontSize(size)
          document.documentElement.classList.toggle('dark', theme === 'dark')
          render(
            withTranslations(
              <div data-testid="composer" style={{ width }}>
                <ThreadModelWarning
                  modelId={'owner/very-long-model-name-without-spaces-'.repeat(
                    8
                  )}
                />
              </div>
            )
          )
          await settle()
          expectNoHorizontalOverflow(screen.getByTestId('composer'))
          expectNoHorizontalOverflow(screen.getByRole('status'))
        })
      }
})
