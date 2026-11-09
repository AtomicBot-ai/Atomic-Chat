import { render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { expect, it } from 'vitest'

import ProvidersAvatar from '@/containers/ProvidersAvatar'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  setFontSize,
  setTheme,
} from '@/test/layout'

for (const [width, font, theme] of [
  [1280, DEFAULT_FONT_SIZE, 'light'],
  [1024, XL_FONT_SIZE, 'dark'],
] as const) {
  it(`loads the FastFlowLM mark in its avatar slots: ${width}px / ${theme}`, async () => {
    await page.viewport(width, 800)
    setFontSize(font)
    setTheme(theme)
    const { container } = render(
      <div className="flex items-center gap-4">
        {['size-4.5', 'size-6', 'size-8'].map((className) => (
          <ProvidersAvatar
            key={className}
            provider={{ provider: 'fastflowlm' } as ProviderObject}
            className={className}
          />
        ))}
      </div>
    )
    const marks = screen.getAllByRole<HTMLImageElement>('img', {
      name: 'fastflowlm - Logo',
    })
    await Promise.all(marks.map((mark) => mark.decode()))
    marks.forEach((mark, index) => {
      expect(mark.naturalWidth).toBeGreaterThan(0)
      expect(mark.getBoundingClientRect().width).toBe([18, 24, 32][index])
      expect(mark.getBoundingClientRect().height).toBe([18, 24, 32][index])
    })
    expectNoHorizontalOverflow(container)
  })
}
