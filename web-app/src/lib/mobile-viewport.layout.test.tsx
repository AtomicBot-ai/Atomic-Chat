import { act, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ImageParamSlider } from '@/containers/images/ImageParamSlider'
import { AudioPromptForm } from '@/containers/audios/AudioPromptForm'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  setFontSize,
  settle,
  withTranslations,
  expectNoHorizontalOverflow,
} from '@/test/layout'
import { setupMobileViewport } from './mobile-viewport'

describe('desktop input typography after a narrow-window launch', () => {
  const originalStyles = new Set(document.head.querySelectorAll('style'))
  afterEach(() => {
    document.head.querySelectorAll('style').forEach((style) => {
      if (!originalStyles.has(style)) style.remove()
    })
  })

  it.each(
    [1024, 1280].flatMap((width) =>
      [DEFAULT_FONT_SIZE, XL_FONT_SIZE].map((fontSize) => ({ width, fontSize }))
    )
  )(
    'uses the interface scale at $width px / $fontSize',
    async ({ width, fontSize }) => {
      await page.viewport(640, 800)
      setupMobileViewport()
      await page.viewport(width, 900)
      setFontSize(fontSize)
      render(
        <div className="w-[340px]">
          <span data-testid="reference" className="text-sm">
            Select a model
          </span>
          <Textarea
            aria-label="Prompt"
            defaultValue="A single red ceramic mug"
          />
          <Input aria-label="Seed" defaultValue="739" />
          <ImageParamSlider
            id="steps"
            label="Steps"
            value={8}
            min={1}
            max={50}
            onChange={vi.fn()}
          />
        </div>
      )
      await act(async () => {
        await settle()
      })
      const reference = getComputedStyle(
        screen.getByTestId('reference')
      ).fontSize
      for (const label of ['Prompt', 'Seed', 'Steps']) {
        expect(
          getComputedStyle(
            screen.getByLabelText(label, { selector: 'input, textarea' })
          ).fontSize
        ).toBe(reference)
      }
    }
  )

  it.each([DEFAULT_FONT_SIZE, XL_FONT_SIZE])(
    'scales the audio form inputs at %s',
    async (fontSize) => {
      await page.viewport(640, 800)
      setupMobileViewport()
      await page.viewport(1024, 900)
      setFontSize(fontSize)
      const { container } = render(
        withTranslations(
          <div className="flex h-[800px] w-[340px]">
            <AudioPromptForm modelsOpen={false} onModelsOpenChange={vi.fn()} />
          </div>
        )
      )
      await act(async () => {
        await settle()
      })
      const inputs = container.querySelectorAll('input, textarea')
      expect(inputs.length).toBeGreaterThan(1)
      for (const input of inputs) {
        expect(parseFloat(getComputedStyle(input).fontSize)).toBeCloseTo(
          parseFloat(fontSize) * 0.875
        )
      }
      expectNoHorizontalOverflow(container)
    }
  )
})
