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
      if (key === 'images:progress.finalizingImage') return 'Finalizing image…'
      if (key === 'images:progress.phase.decoding') return 'Decoding image…'
      if (key === 'images:progress.phase.postprocessing') return 'Preparing final image…'
      if (key === 'images:progress.phase.saving') return 'Saving to gallery…'
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
    expect(tile.querySelectorAll('span')).toHaveLength(1)
    expect(within(tile).queryByText('Step 7/20')).not.toBeInTheDocument()
    expect(tile).not.toHaveTextContent('12 s')
  })

  it('stops presenting a completed sampling count as completed work', () => {
    render(
      <ImageGenerationPlaceholder
        variant="viewer"
        width={1024}
        height={1024}
        progress={{ ...progress, step: 20, totalSteps: 20, etaSeconds: 9 }}
        startedAtMs={0}
      />
    )

    const preview = screen.getByTestId('image-generation-preview')
    expect(preview).toHaveTextContent('Finalizing image…')
    expect(preview).not.toHaveTextContent('Step 20/20')
    expect(preview).not.toHaveTextContent('~9 s')
    expect(preview).toHaveTextContent('12 s')
  })

  it.each([
    ['decoding', 'Decoding image…'],
    ['postprocessing', 'Preparing final image…'],
    ['saving', 'Saving to gallery…'],
  ] as const)('maps the %s phase to a human finalization state', (phase, label) => {
    render(
      <ImageGenerationPlaceholder
        variant="viewer"
        width={1024}
        height={1024}
        progress={{ ...progress, phase, step: 20, totalSteps: 20 }}
        startedAtMs={0}
      />
    )

    const preview = screen.getByTestId('image-generation-preview')
    expect(preview).toHaveTextContent(label)
    expect(preview).not.toHaveTextContent('Step 20/20')
    expect(preview).not.toHaveTextContent('~18 s')
  })

  it('keeps a finalizing gallery tile visually text-free', () => {
    render(
      <ImageGenerationPlaceholder
        variant="tile"
        width={1024}
        height={1024}
        progress={{ ...progress, phase: 'saving', step: 20, totalSteps: 20 }}
        startedAtMs={0}
      />
    )

    const tile = screen.getByTestId('image-generation-tile-0')
    expect(tile.querySelectorAll('span')).toHaveLength(1)
    expect(tile.querySelector('span')).toHaveClass('sr-only')
    expect(tile).not.toHaveTextContent('12 s')
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

  it('keeps outer dots diffuse and muted even at the wave peak', () => {
    render(
      <ImageGenerationPlaceholder
        variant="tile"
        width={1024}
        height={1024}
        progress={progress}
        startedAtMs={0}
      />
    )
    const dots = Array.from(
      screen.getByTestId('generation-dotted-field').querySelectorAll('circle')
    )
    const peakAt = (min: number, max: number) => dots.filter((dot) => {
      const distance = Math.hypot(Number(dot.getAttribute('cx')) - 50, Number(dot.getAttribute('cy')) - 50)
      return distance >= min && distance <= max
    }).map((dot) => Number(dot.style.getPropertyValue('--dot-peak-opacity')))

    expect(Math.min(...peakAt(0, 15))).toBeGreaterThan(0.7)
    expect(Math.max(...peakAt(40, 46))).toBeLessThan(0.12)
    expect(dots.every((dot) => dot.style.getPropertyValue('--dot-blur'))).toBe(true)
  })
})
