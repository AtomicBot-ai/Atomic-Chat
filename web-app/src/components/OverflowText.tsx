import { useLayoutEffect, useRef, useState } from 'react'

/** Scroll only clipped copy; reserve the same single-line box throughout. */
export function OverflowText({
  text,
  className = '',
  title,
}: {
  text: string
  className?: string
  title?: string
}) {
  const viewport = useRef<HTMLSpanElement>(null)
  const track = useRef<HTMLSpanElement>(null)
  const primary = useRef<HTMLSpanElement>(null)
  const [metrics, setMetrics] = useState({ width: 0, viewport: 0 })
  useLayoutEffect(() => {
    const measure = () => {
      const width = primary.current?.scrollWidth ?? 0
      const visible = viewport.current?.clientWidth ?? 0
      setMetrics((previous) =>
        previous.width === width && previous.viewport === visible
          ? previous
          : { width, viewport: visible }
      )
    }
    measure()
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (viewport.current) observer?.observe(viewport.current)
    if (primary.current) observer?.observe(primary.current)
    void document.fonts?.ready.then(measure)
    return () => observer?.disconnect()
  }, [text])
  const overflowing = metrics.width > metrics.viewport + 1
  useLayoutEffect(() => {
    const element = track.current
    if (!element || !overflowing || !element.animate) return
    const pause = 1500
    const end = metrics.width - metrics.viewport
    const cycle = metrics.width + 32
    const endTravel = (end / 30) * 1000
    const duration = pause * 2 + (cycle / 30) * 1000
    // Pause with the first glyph on the left, then with the last on the right.
    // Continue through the gap until the next copy takes the original position;
    // resetting the transform at that boundary is visually identical.
    const animation = element.animate(
      [
        { transform: 'translateX(0)', offset: 0 },
        { transform: 'translateX(0)', offset: pause / duration },
        {
          transform: `translateX(-${end}px)`,
          offset: (pause + endTravel) / duration,
        },
        {
          transform: `translateX(-${end}px)`,
          offset: (pause * 2 + endTravel) / duration,
        },
        { transform: `translateX(-${cycle}px)`, offset: 1 },
      ],
      { duration, iterations: Infinity, easing: 'linear' }
    )
    return () => animation.cancel()
  }, [metrics, overflowing])
  return (
    <span
      ref={viewport}
      title={title ?? text}
      className={`block min-w-0 overflow-hidden whitespace-nowrap ${className}`}
    >
      <span
        ref={track}
        data-testid="overflow-text-track"
        className="inline-flex whitespace-nowrap"
        style={{ columnGap: 32 }}
      >
        <span
          ref={primary}
          data-testid="overflow-text-primary"
          className="shrink-0"
        >
          {text}
        </span>
        {overflowing && (
          <span
            aria-hidden="true"
            data-testid="overflow-text-repeat"
            data-repeat={text}
            className="shrink-0 before:content-[attr(data-repeat)]"
          />
        )}
      </span>
    </span>
  )
}
