import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { MediaPreview } from '../steps/MediaPreview'

/** jsdom has no media playback: play and pause flip `paused` and say so. */
function fakePlayback() {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(
    function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { configurable: true, value: false })
      this.dispatchEvent(new Event('play'))
      return Promise.resolve()
    }
  )
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
    function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { configurable: true, value: true })
      this.dispatchEvent(new Event('pause'))
    }
  )
}

const reducedMotion = (matches: boolean) =>
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList
  )

describe('MediaPreview', () => {
  beforeEach(fakePlayback)
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows the still for images, with no player controls', () => {
    reducedMotion(false)
    const { container } = render(<MediaPreview modality="image" />)
    const still = screen.getByRole('img', {
      name: 'onboarding-media:preview.imageAlt',
    })
    expect(still).toHaveAttribute('src', '/images/onboarding/robot-studio.webp')
    expect(container.querySelector('video')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(container).toHaveTextContent('onboarding-media:art.image')
  })

  it('plays a muted loop for video that pauses and resumes', () => {
    reducedMotion(false)
    const { container } = render(<MediaPreview modality="video" />)
    const video = container.querySelector('video')!
    expect(video.src).toContain('/images/onboarding/robot-wave.mp4')
    expect(video.poster).toContain('/images/onboarding/robot-studio.webp')
    expect(video.loop).toBe(true)
    expect(video.muted).toBe(true)
    expect(video.paused).toBe(false)

    fireEvent.click(
      screen.getByRole('button', { name: 'onboarding-media:preview.pause' })
    )
    expect(video.paused).toBe(true)
    fireEvent.click(
      screen.getByRole('button', { name: 'onboarding-media:preview.play' })
    )
    expect(video.paused).toBe(false)
  })

  it('stays on the first frame when the system asks for reduced motion', () => {
    reducedMotion(true)
    const { container } = render(<MediaPreview modality="video" />)
    expect(container.querySelector('video')!.paused).toBe(true)
    expect(
      screen.getByRole('button', { name: 'onboarding-media:preview.play' })
    ).toBeInTheDocument()
  })
})
