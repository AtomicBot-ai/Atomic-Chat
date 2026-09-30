import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useReasoningAutoScroll } from '../useReasoningAutoScroll'

type HarnessProps = {
  isStreaming: boolean
  revision: number
}

function Harness({ isStreaming, revision }: HarnessProps) {
  const { containerRef, onScroll } = useReasoningAutoScroll(
    isStreaming,
    revision
  )

  return <div ref={containerRef} onScroll={onScroll} data-testid="reasoning" />
}

describe('useReasoningAutoScroll', () => {
  let frames: Map<number, FrameRequestCallback>
  let nextFrameId: number

  beforeEach(() => {
    frames = new Map()
    nextFrameId = 1
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrameId++
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const flushFrames = () => {
    const pending = [...frames.entries()]
    frames.clear()
    for (const [, callback] of pending) callback(performance.now())
  }

  const installScrollMetrics = (element: HTMLElement) => {
    const metrics = {
      clientHeight: 128,
      scrollHeight: 128,
      scrollTop: 0,
      /** Set by any write that moved the box, like a browser queueing an event. */
      scrollEventPending: false,
    }

    Object.defineProperties(element, {
      clientHeight: { get: () => metrics.clientHeight },
      scrollHeight: { get: () => metrics.scrollHeight },
      scrollTop: {
        get: () => metrics.scrollTop,
        set: (value: number) => {
          const next = Math.min(
            value,
            Math.max(0, metrics.scrollHeight - metrics.clientHeight)
          )
          if (next !== metrics.scrollTop) metrics.scrollEventPending = true
          metrics.scrollTop = next
        },
      },
    })

    return metrics
  }

  it('keeps following when streamed content grows beyond the threshold', () => {
    const { rerender } = render(<Harness isStreaming revision={1} />)
    const container = screen.getByTestId('reasoning')
    const metrics = installScrollMetrics(container)

    act(flushFrames)
    expect(metrics.scrollTop).toBe(0)

    metrics.scrollHeight = 300
    rerender(<Harness isStreaming revision={2} />)
    act(flushFrames)

    expect(metrics.scrollTop).toBe(172)
  })

  // A programmatic tail scroll queues a `scroll` event that the browser only
  // delivers on the next frame, by which point the next token batch has
  // already grown the box. Measuring the distance then reports the growth,
  // which is how a large chunk used to end tail-following for the rest of the
  // turn.
  it('keeps following when a large chunk lands before its own scroll event', () => {
    const { rerender } = render(<Harness isStreaming revision={1} />)
    const container = screen.getByTestId('reasoning')
    const metrics = installScrollMetrics(container)

    metrics.scrollHeight = 300
    act(flushFrames)
    expect(metrics.scrollTop).toBe(172)
    expect(metrics.scrollEventPending).toBe(true)

    // Next commit lands a chunk several lines tall, then the browser delivers
    // the scroll event left over from the write above.
    metrics.scrollHeight = 900
    metrics.scrollEventPending = false
    fireEvent.scroll(container)

    rerender(<Harness isStreaming revision={2} />)
    act(flushFrames)

    expect(metrics.scrollTop).toBe(772)
  })

  it('pauses for a reader scroll and resumes when they return to the tail', () => {
    const { rerender } = render(<Harness isStreaming revision={1} />)
    const container = screen.getByTestId('reasoning')
    const metrics = installScrollMetrics(container)

    metrics.scrollHeight = 300
    act(flushFrames)
    expect(metrics.scrollTop).toBe(172)

    metrics.scrollTop = 40
    fireEvent.scroll(container)
    metrics.scrollHeight = 400
    rerender(<Harness isStreaming revision={2} />)
    act(flushFrames)
    expect(metrics.scrollTop).toBe(40)

    metrics.scrollTop = 272
    fireEvent.scroll(container)
    metrics.scrollHeight = 500
    rerender(<Harness isStreaming revision={3} />)
    act(flushFrames)
    expect(metrics.scrollTop).toBe(372)
  })

  // The guard must only swallow the event a real write produced. A tail write
  // that changed nothing queues no event, so the reader's next scroll has to
  // be honoured even when it happens to land on the same offset.
  it('honours a reader scroll back to the offset the last tail write used', () => {
    const { rerender } = render(<Harness isStreaming revision={1} />)
    const container = screen.getByTestId('reasoning')
    const metrics = installScrollMetrics(container)

    metrics.scrollHeight = 300
    act(flushFrames)
    expect(metrics.scrollTop).toBe(172)
    fireEvent.scroll(container) // the write's own event, skipped

    // Content stops growing: the next tail write is a no-op and queues nothing.
    rerender(<Harness isStreaming revision={2} />)
    act(flushFrames)
    expect(metrics.scrollTop).toBe(172)

    // The reader scrolls up and the box then grows: following must be paused.
    metrics.scrollTop = 20
    fireEvent.scroll(container)
    metrics.scrollHeight = 600
    rerender(<Harness isStreaming revision={3} />)
    act(flushFrames)
    expect(metrics.scrollTop).toBe(20)
  })
  it('marks only edges with more content, including growth while paused', () => {
    const { rerender } = render(<Harness isStreaming revision={1} />)
    const container = screen.getByTestId('reasoning')
    const metrics = installScrollMetrics(container)
    act(flushFrames)
    expect(container).toHaveAttribute('data-overflow-top', 'false')
    expect(container).toHaveAttribute('data-overflow-bottom', 'false')

    metrics.scrollHeight = 400
    rerender(<Harness isStreaming revision={2} />)
    act(flushFrames)
    expect(metrics.scrollTop).toBe(272)
    expect(container).toHaveAttribute('data-overflow-top', 'true')
    expect(container).toHaveAttribute('data-overflow-bottom', 'false')

    metrics.scrollTop = 80
    fireEvent.scroll(container)
    expect(container).toHaveAttribute('data-overflow-bottom', 'true')
    metrics.scrollHeight = 700
    rerender(<Harness isStreaming revision={3} />)
    act(flushFrames)
    expect(metrics.scrollTop).toBe(80)
    expect(container).toHaveAttribute('data-overflow-bottom', 'true')

    metrics.scrollTop = 0
    fireEvent.scroll(container)
    expect(container).toHaveAttribute('data-overflow-top', 'false')
  })

  it('cancels pending scrolling on finish and follows a new stream', () => {
    const { rerender, unmount } = render(<Harness isStreaming revision={1} />)
    const container = screen.getByTestId('reasoning')
    const metrics = installScrollMetrics(container)
    metrics.scrollHeight = 400
    rerender(<Harness isStreaming={false} revision={2} />)
    act(flushFrames)
    expect(metrics.scrollTop).toBe(0)
    rerender(<Harness isStreaming revision={3} />)
    act(flushFrames)
    expect(metrics.scrollTop).toBe(272)
    metrics.scrollHeight = 600
    rerender(<Harness isStreaming revision={4} />)
    unmount()
    act(flushFrames)
    expect(metrics.scrollTop).toBe(272)
  })

  it('follows a reflow without new tokens but preserves a reader scroll', () => {
    let resize: () => void = () => {}
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback
        }
        observe() {}
        disconnect() {}
      }
    )
    render(<Harness isStreaming revision={1} />)
    const container = screen.getByTestId('reasoning')
    const metrics = installScrollMetrics(container)
    metrics.scrollHeight = 400
    act(flushFrames)
    fireEvent.scroll(container)
    metrics.scrollHeight = 600
    act(() => {
      resize()
      flushFrames()
    })
    expect(metrics.scrollTop).toBe(472)
    expect(container).toHaveAttribute('data-overflow-bottom', 'false')

    metrics.scrollTop = 100
    fireEvent.scroll(container)
    metrics.scrollHeight = 800
    act(() => {
      resize()
      flushFrames()
    })
    expect(metrics.scrollTop).toBe(100)
    expect(container).toHaveAttribute('data-overflow-bottom', 'true')
  })
})
