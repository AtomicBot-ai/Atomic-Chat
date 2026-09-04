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

  const cancelPendingFrame = useCallback(() => {
    if (frameRef.current === null) return
    cancelAnimationFrame(frameRef.current)
    frameRef.current = null
  }, [])

  const onScroll = useCallback<UIEventHandler<HTMLDivElement>>((event) => {
    const container = event.currentTarget
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight
    shouldFollowRef.current =
      distanceFromBottom <= REASONING_AUTO_SCROLL_THRESHOLD_PX
  }, [])

  useEffect(() => {
    if (!isStreaming) {
      shouldFollowRef.current = true
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
      currentContainer.scrollTop = currentContainer.scrollHeight
    })
  }, [cancelPendingFrame, isStreaming, streamRevision])

  useEffect(() => cancelPendingFrame, [cancelPendingFrame])

  return { containerRef, onScroll }
}
