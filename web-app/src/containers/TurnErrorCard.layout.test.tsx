import { fireEvent, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { describe, expect, it, vi } from 'vitest'

import { TurnErrorCard } from './TurnErrorCard'
import { formatTransportError } from '@/lib/transport-error'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectOneLine,
  expectVerticallyCentered,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'

// A diagnostic with an unbroken token, the shape that used to need the old
// card's `table-fixed` wrapper to wrap at all.
const DIAGNOSTIC = `${formatTransportError(
  'body_eof',
  'error decoding response body: '
)}${'x'.repeat(240)}\n    at stream (http.rs:120:9)`

/** Design review D7: 12–16 px of padding inside the card. */
function expectInnerPadding(el: HTMLElement) {
  const style = getComputedStyle(el)
  for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
    const value = parseFloat(style[`padding${side}`])
    expect(value, `padding-${side.toLowerCase()}`).toBeGreaterThanOrEqual(12)
    expect(value, `padding-${side.toLowerCase()}`).toBeLessThanOrEqual(16)
  }
}

/** The body text token (`text-sm`, what `<body>` and chat turns use) at its 20/14 leading. */
function expectBodyScale(el: HTMLElement) {
  const style = getComputedStyle(el)
  const body = getComputedStyle(document.body)
  expect(style.fontSize).toBe(body.fontSize)
  const ratio = parseFloat(style.lineHeight) / parseFloat(style.fontSize)
  expect(ratio).toBeCloseTo(20 / 14, 2)
}

describe.each(['light', 'dark'] as const)(
  'turn error card in %s theme',
  (theme) => {
    it.each([DEFAULT_FONT_SIZE, XL_FONT_SIZE])(
      'reads at the body scale and keeps its diagnostic inside at %s',
      async (fontSize) => {
        await page.viewport(900, 800)
        setTheme(theme)
        setFontSize(fontSize)
        render(
          withTranslations(
            <div style={{ width: 640 }}>
              <TurnErrorCard
                error={new Error(DIAGNOSTIC)}
                providerId="llamacpp-upstream"
                settingsRestartModel="Qwen3.5 4B"
                onRetry={vi.fn()}
                onShortenHistory={vi.fn()}
                onIncreaseContext={vi.fn()}
                onOpenEngineSettings={vi.fn()}
              />
            </div>
          )
        )
        await settle()

        const card = screen.getByTestId('turn-error-card')
        const title = screen.getByText(
          'The model restarted after a settings change'
        )
        const body = screen.getByText(
          /Your settings change restarted Qwen3.5 4B/
        )
        const icon = card.querySelector('svg')!

        expectInnerPadding(card)
        expectBodyScale(title)
        expectBodyScale(body)
        expectOneLine(title)
        expectVerticallyCentered(icon, title)

        const retry = screen.getByRole('button', { name: 'Retry' })
        expect(retry.getBoundingClientRect().width).toBeGreaterThan(40)

        const summary = screen.getByText('Details')
        expect(summary.closest('details')!.open).toBe(false)
        fireEvent.click(summary)
        await settle()
        expect(summary.closest('details')!.open).toBe(true)
        expectNoHorizontalOverflow(card)
      }
    )
  }
)
