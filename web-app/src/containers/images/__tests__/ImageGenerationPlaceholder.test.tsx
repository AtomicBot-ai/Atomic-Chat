import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ImageJobProgress } from '@/services/diffusion/types'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, number>) => {
      if (key === 'images:progress.generatingImage') return 'Generating image'
      if (key === 'images:progress.step') {
        return `Step ${values?.step}/${values?.total}`
      }
      if (key === 'images:progress.elapsed') return `${values?.seconds} s`
      if (key === 'images:progress.phase.queued') return 'Queued'
      return key
    },
  }),
}))

import { ImageGenerationPlaceholder } from '../ImageGenerationPlaceholder'

const progress: ImageJobProgress = {
  phase: 'sampling',
  step: 7,
  totalSteps: 20,
  fraction: 0.35,
  etaSeconds: 18,
  batchIndex: 0,
  batchSize: 1,
  elapsedMs: 12_000,
}

describe('ImageGenerationPlaceholder', () => {
  it('exposes viewer progress as a polite accessible status', () => {
    render(
      <ImageGenerationPlaceholder
        variant="viewer"
        width={1024}
        height={1024}
        progress={progress}
        startedAtMs={0}
      />
    )

    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(
      screen.getByTestId('image-generation-progress-announcement')
    ).toHaveTextContent('Generating image. Step 7/20.')
    expect(status).toHaveTextContent('12 s')
  })

  it('uses the same dotted field and accessible progress in pending tiles', () => {
    render(
      <ImageGenerationPlaceholder
        variant="tile"
        width={1024}
        height={1024}
        progress={progress}
        startedAtMs={0}
        index={2}
      />
    )

    const tile = screen.getByTestId('image-generation-tile-2')
    expect(tile).toHaveAttribute('role', 'status')
    expect(
      within(tile).getByTestId('image-generation-progress-announcement')
    ).toHaveTextContent('Generating image. Step 7/20.')
    expect(within(tile).getByTestId('generation-dotted-field')).toBeVisible()
  })

  it('marks the field and every dot with a static reduced-motion fallback', () => {
    render(
      <ImageGenerationPlaceholder
        variant="viewer"
        width={1024}
        height={768}
        progress={progress}
        startedAtMs={0}
      />
    )

    const field = screen.getByTestId('generation-dotted-field')
    expect(field).toHaveClass('generation-dotted-field')
    expect(field).toHaveAttribute('data-reduced-motion-fallback', 'static')

    const dots = field.querySelectorAll('.generation-dot')
    expect(dots.length).toBeGreaterThan(140)
    expect(
      Array.from(dots).every((dot) =>
        (dot.getAttribute('style') ?? '').includes('--dot-static-opacity')
      )
    ).toBe(true)
  })
})
