import {
  useCallback,
  useEffect,
  useRef,
  type RefObject,
  type UIEventHandler,
} from 'react'

const REASONING_AUTO_SCROLL_THRESHOLD_PX = 24

type ReasoningAutoScroll = {
  containerRef: RefObject<HTMLDivElement | null>
  onScroll: UIEventHandler<HTMLDivElement>
}

/**
 * Keeps a streaming reasoning panel at its tail without treating content
 * growth as a user scroll. A real scroll event is the only thing that changes
 * whether the panel should continue following.
 */
export function useReasoningAutoScroll(
  isStreaming: boolean,
  streamRevision: unknown
): ReasoningAutoScroll {
  const containerRef = useRef<HTMLDivElement>(null)
  const shouldFollowRef = useRef(true)
  const frameRef = useRef<number | null>(null)
  const programmaticTopRef = useRef<number | null>(null)

  const cancelPendingFrame = useCallback(() => {
    if (frameRef.current === null) return
    cancelAnimationFrame(frameRef.current)
    frameRef.current = null
  }, [])

  const onScroll = useCallback<UIEventHandler<HTMLDivElement>>((event) => {
    const container = event.currentTarget
    // The tail scroll below emits a `scroll` event too, and the browser
    // delivers it during the *next* frame's scroll steps — after React has
    // already committed another token batch and grown `scrollHeight`. The
    // distance measured then is the growth, not a reader's intent, so a
    // chunk taller than the threshold would silently end tail-following.
    // Skipping the event our own write produced is what keeps that from
    // happening.
    if (programmaticTopRef.current === container.scrollTop) {
      programmaticTopRef.current = null
      return
    }

    programmaticTopRef.current = null
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight
    shouldFollowRef.current =
      distanceFromBottom <= REASONING_AUTO_SCROLL_THRESHOLD_PX
  }, [])

  useEffect(() => {
    if (!isStreaming) {
      shouldFollowRef.current = true
      programmaticTopRef.current = null
      cancelPendingFrame()
      return
    }

    const container = containerRef.current
    if (!container || !shouldFollowRef.current || frameRef.current !== null) {
      return
    }

    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      const currentContainer = containerRef.current
      if (!currentContainer || !shouldFollowRef.current) return

      const previousTop = currentContainer.scrollTop
      currentContainer.scrollTop = currentContainer.scrollHeight
      // Only a write that actually moved the box emits an event to skip.
      // Arming the guard after a no-op write would swallow the reader's next
      // scroll instead.
      programmaticTopRef.current =
        currentContainer.scrollTop === previousTop
          ? null
          : currentContainer.scrollTop
    })
  }, [cancelPendingFrame, isStreaming, streamRevision])

  useEffect(() => cancelPendingFrame, [cancelPendingFrame])

  return { containerRef, onScroll }
}
