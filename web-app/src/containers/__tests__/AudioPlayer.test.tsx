import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { AudioPlayer } from '../AudioPlayer'

// The seek bar is a Radix slider, which measures its thumb.
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const SRC = 'asset://localhost/%2Fdata%2Faudios%2Fclip.wav'

describe('AudioPlayer switching clips (QA 2.3.2)', () => {
  let load: ReturnType<typeof vi.spyOn>

  beforeAll(() => {
    globalThis.ResizeObserver =
      MockResizeObserver as unknown as typeof ResizeObserver
  })

  beforeEach(() => {
    vi.useFakeTimers()
    load = vi
      .spyOn(HTMLMediaElement.prototype, 'load')
      .mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    load.mockRestore()
  })

  it('shows the known length and an enabled Play at once, and no spinner for a quick load', () => {
    const { container } = render(
      <AudioPlayer src={SRC} mediaType="audio/wav" durationHint={30.2} />
    )
    const play = screen.getByRole('button', { name: 'Play' })

    expect(screen.getByText('0:00 / 0:30')).toBeInTheDocument()
    expect(play).toBeEnabled()
    expect(container.querySelector('.animate-spin')).toBeNull()
    // The element loads its first source itself; a second load() would restart it.
    expect(load).not.toHaveBeenCalled()

    act(() => {
      fireEvent(container.querySelector('audio')!, new Event('canplay'))
      vi.advanceTimersByTime(1000)
    })
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('shows the spinner only once a load is slow', () => {
    const { container } = render(
      <AudioPlayer src={SRC} mediaType="audio/wav" />
    )

    act(() => vi.advanceTimersByTime(299))
    expect(container.querySelector('.animate-spin')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(container.querySelector('.animate-spin')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled()
  })

  it('reloads when the same player is given another clip', () => {
    const { container, rerender } = render(
      <AudioPlayer src={SRC} mediaType="audio/wav" />
    )
    rerender(<AudioPlayer src={`${SRC}?next`} mediaType="audio/wav" />)
    expect(container.querySelector('audio')).toHaveAttribute(
      'src',
      `${SRC}?next`
    )
    expect(load).toHaveBeenCalledTimes(1)
  })
})
