/**
 * Setup for the real-browser layout suite (`vitest.layout.config.ts`).
 *
 * Loads the app's stylesheet — Tailwind 4 through the app's own Vite plugin,
 * and `styles/font.css` with it, so text is set in the bundled Inter — and
 * gives the document the two things `InterfaceProvider` gives it at runtime
 * that the CSS has no fallback for: `--font-size-base` (the type scale is
 * built on it; unset, every `text-*` utility computes to nothing) and the
 * theme class. Then it waits for the Inter faces a component can wear before
 * the first test measures anything, since `font-display: swap` would let a
 * test read the fallback font's widths.
 */
import '@/index.css'
import { afterEach, beforeAll } from 'vitest'
import { cleanup } from '@testing-library/react'

import { DEFAULT_FONT_SIZE, setFontSize, setTheme } from './layout'

setFontSize(DEFAULT_FONT_SIZE)
setTheme('light')

beforeAll(async () => {
  // Every weight the primitives use: regular text, `font-medium` titles and
  // buttons, `font-semibold` badges. `load` fetches a face that nothing has
  // rendered yet; `ready` then waits for the fetches.
  await Promise.all(
    ['400', '500', '600', '700'].map((weight) =>
      document.fonts.load(`${weight} 16px Inter`)
    )
  )
  await document.fonts.ready
})

afterEach(() => {
  cleanup()
  setFontSize(DEFAULT_FONT_SIZE)
  setTheme('light')
})
