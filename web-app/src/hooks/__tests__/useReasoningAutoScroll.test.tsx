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

  return (
    <div ref={containerRef} onScroll={onScroll} data-testid="reasoning" />
  )
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
    }

    Object.defineProperties(element, {
      clientHeight: { get: () => metrics.clientHeight },
      scrollHeight: { get: () => metrics.scrollHeight },
      scrollTop: {
        get: () => metrics.scrollTop,
        set: (value: number) => {
          metrics.scrollTop = Math.min(
            value,
            Math.max(0, metrics.scrollHeight - metrics.clientHeight)
          )
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
})
