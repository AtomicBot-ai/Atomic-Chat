import { render, screen, within } from '@testing-library/react'
import { cdp, page } from '@vitest/browser/context'
import type {} from '@vitest/browser/providers/playwright'
import { describe, expect, it } from 'vitest'

import { setFontSize, setTheme, withTranslations } from '@/test/layout'
import { ImageGenerationPlaceholder } from './ImageGenerationPlaceholder'

describe('image generation placeholder geometry', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const fontSize of ['16px', '20px']) {
      it(`fills the thumbnail and enlarges the preview at ${fontSize} in ${theme}`, async () => {
        await page.viewport(fontSize === '20px' ? 1024 : 1280, 800)
        setTheme(theme)
        setFontSize(fontSize)
        const props = {
          width: 1024,
          height: 1024,
          progress: null,
          startedAtMs: Date.now(),
        }
        const view = render(withTranslations(
          <div className="flex gap-4">
            <div className="size-24">
              <ImageGenerationPlaceholder {...props} variant="tile" />
            </div>
            <div className="h-[420px] w-[400px]">
              <ImageGenerationPlaceholder {...props} variant="viewer" />
            </div>
          </div>
        ))
        await document.fonts.ready
        // Freeze a common point in the loop for reliable size measurements.
        for (const animation of view.container.getAnimations({ subtree: true })) {
          animation.pause()
          animation.currentTime = 0
        }
        const tile = screen.getByTestId('image-generation-tile-0')
        const tileField = within(tile).getByTestId('generation-dotted-field')
        const preview = screen.getByTestId('image-generation-preview')
        const viewerField = within(preview).getByTestId('generation-dotted-field')
        const tileSize = tileField.getBoundingClientRect().width
        const viewerSize = viewerField.getBoundingClientRect().width
        expect(tileSize).toBeGreaterThan(tile.clientWidth * 0.85)
        expect(tileSize).toBeLessThanOrEqual(tile.clientWidth)
        expect(viewerSize).toBeGreaterThanOrEqual(176)
        expect(viewerSize).toBeLessThan(preview.clientWidth)
        // The tile retains its accessible status, with no visible caption.
        expect(tile.innerText.trim()).toBe('Generating image. Queued.')
        const announcement = within(tile).getByTestId('image-generation-progress-announcement')
        expect(announcement.getBoundingClientRect().width).toBe(1)
        expect(tile.querySelectorAll('span')).toHaveLength(1)
      })
    }
  }

  it('stops all motion and retains diffuse dots with reduced motion enabled', async () => {
    const session = cdp()
    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
    try {
      render(
        <div className="size-24">
          <ImageGenerationPlaceholder variant="tile" width={1024} height={1024}
            progress={null} startedAtMs={Date.now()} />
        </div>
      )
      const field = screen.getByTestId('generation-dotted-field')
      expect(getComputedStyle(field).animationName).toBe('none')
      expect(field.getAnimations({ subtree: true })).toHaveLength(0)
      const dots = Array.from(field.querySelectorAll('circle'))
      expect(dots.every((dot) => getComputedStyle(dot).animationName === 'none')).toBe(true)
      expect(dots.some((dot) => Number(getComputedStyle(dot).opacity) > 0.4)).toBe(true)
      expect(dots.some((dot) => Number(getComputedStyle(dot).opacity) < 0.05)).toBe(true)
    } finally {
      await session.send('Emulation.setEmulatedMedia', { features: [] })
    }
  })
})
