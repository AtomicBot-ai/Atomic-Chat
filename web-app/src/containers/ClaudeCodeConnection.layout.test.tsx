import { render, cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { page } from '@vitest/browser/context'
import { ClaudeCodeConnectionCard } from './ClaudeCodeConnection'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'
const noop = () => {}
afterEach(cleanup)
for (const width of [1024, 1280])
  for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE])
    for (const theme of ['light', 'dark'] as const) {
      describe(`${width}px ${font} ${theme}`, () => {
        it('keeps the connection controls and long status inside the content column', async () => {
          await page.viewport(width, 800)
          setFontSize(font)
          setTheme(theme)
          render(
            withTranslations(
              <div
                data-testid="content-column"
                style={{ width: width - 280, maxWidth: 768, padding: 16 }}
              >
                <ClaudeCodeConnectionCard
                  status={{
                    installed: true,
                    loggedIn: true,
                    subscription: true,
                    plan: 'Enterprise with a long organization label',
                    version: '2.1.281 (Claude Code)',
                    error: null,
                    models: [],
                  }}
                  enabled
                  onEnabled={noop}
                  onConnect={noop}
                  onCancel={noop}
                  onRefresh={noop}
                  onInstall={noop}
                />
              </div>
            )
          )
          await settle()
          expectNoHorizontalOverflow(screen.getByTestId('content-column'))
          expect(
            screen
              .getByRole('button', { name: 'Connect in browser' })
              .getBoundingClientRect().width
          ).toBeGreaterThan(0)
        })
      })
    }
