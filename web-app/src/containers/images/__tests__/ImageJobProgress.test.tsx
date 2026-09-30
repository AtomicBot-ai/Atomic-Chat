import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TranslationContext } from '@/i18n/context'
import i18n from '@/i18n/setup'
import { makeJob } from '@/lib/diffusion/__tests__/image-fixtures'
import type { ImageJobProgress as Progress } from '@/services/diffusion/types'
import { ImageJobProgress } from '../ImageJobProgress'

/** Real English copy, so the assembled line is what the user reads. */
const withI18n = (ui: React.ReactElement) =>
  render(
    <TranslationContext.Provider value={{ t: i18n.t, i18n }}>
      {ui}
    </TranslationContext.Provider>
  )

const sampling: Progress = {
  phase: 'sampling',
  step: 12,
  totalSteps: 28,
  fraction: 0.43,
  etaSeconds: 14.2,
  batchIndex: 1,
  batchSize: 4,
  elapsedMs: 9_000,
}

describe('ImageJobProgress', () => {
  it('reads step, eta, image and run as one line', () => {
    withI18n(
      <ImageJobProgress
        job={makeJob({ state: 'generating', progress: sampling })}
        runsTotal={3}
        runsDone={0}
        stopping={false}
      />
    )
    expect(screen.getByText('Step 12/28 · ~14 s · image 2 of 4 · run 1 of 3')).toBeInTheDocument()
    // The bar fills to the plugin's overall estimate, not to the step count.
    const indicator = screen
      .getByRole('progressbar')
      .querySelector('[data-slot="progress-indicator"]') as HTMLElement
    expect(indicator.style.transform).toBe('translateX(-57%)')
  })

  it('announces changes politely rather than assertively', () => {
    withI18n(
      <ImageJobProgress
        job={makeJob({ state: 'generating', progress: sampling })}
        runsTotal={1}
        runsDone={0}
        stopping={false}
      />
    )
    const line = screen.getByText(/Step 12\/28/)
    expect(line).toHaveAttribute('aria-live', 'polite')
  })

  it('drops the parts that do not apply to a single image, single run', () => {
    withI18n(
      <ImageJobProgress
        job={makeJob({
          state: 'generating',
          progress: { ...sampling, batchIndex: 0, batchSize: 1, etaSeconds: null },
        })}
        runsTotal={1}
        runsDone={0}
        stopping={false}
      />
    )
    expect(screen.getByText('Step 12/28')).toBeInTheDocument()
  })

  it('names the phase while no step line has arrived', () => {
    withI18n(
      <ImageJobProgress
        job={makeJob({ state: 'queued', progress: null })}
        runsTotal={2}
        runsDone={1}
        stopping={false}
      />
    )
    expect(screen.getByText('Queued · run 2 of 2')).toBeInTheDocument()
  })

  it('says the renderer is being stopped after Stop, because that is what happens', () => {
    withI18n(
      <ImageJobProgress
        job={makeJob({ state: 'generating', progress: sampling })}
        runsTotal={1}
        runsDone={0}
        stopping
      />
    )
    expect(screen.getByText(/Stopping the renderer/)).toBeInTheDocument()
    expect(screen.queryByText(/Step 12/)).not.toBeInTheDocument()
  })

  it('renders nothing without a job', () => {
    const { container } = withI18n(
      <ImageJobProgress job={null} runsTotal={0} runsDone={0} stopping={false} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
