import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
} from 'react'

/** How long a card shows in full after it appears, before it folds. */
export const AUTO_COLLAPSE_MS = 3000

export type AutoCollapse = {
  collapsed: boolean
  /** A click on the small version: open, and stay open until left. */
  expand: () => void
  /** The card's own collapse control. */
  collapse: () => void
  /** Show in full again for another `AUTO_COLLAPSE_MS`, as on appearing. */
  peek: () => void
  /** Spread on the full card: pointer or focus inside holds it open. */
  holdProps: {
    onPointerEnter: () => void
    onPointerLeave: () => void
    onFocus: () => void
    onBlur: (event: FocusEvent<HTMLElement>) => void
  }
}

/**
 * A corner card that shows in full when it appears and folds into its small
 * version `AUTO_COLLAPSE_MS` later, so the corner says what started without
 * covering the window while it runs. The small version keeps the essentials
 * on screen (what, how far) and opens the card again on click.
 *
 * Folding waits while the pointer is over the card or focus is inside it, and
 * starts over once both leave. A card opened by hand stays open until it is
 * left: whoever opened it is reading it.
 */
export function useAutoCollapse(
  visible: boolean,
  delayMs: number = AUTO_COLLAPSE_MS
): AutoCollapse {
  const [collapsed, setCollapsed] = useState(false)
  const [held, setHeld] = useState(false)
  // Bumped by `peek`, so a card already open restarts its countdown.
  const [epoch, setEpoch] = useState(0)
  const pointerInside = useRef(false)
  const focusInside = useRef(false)
  const wasVisible = useRef(visible)

  // Every appearance starts in full. A layout effect, so a card that left
  // folded never shows its old small version for a frame on its way back.
  useLayoutEffect(() => {
    const appeared = visible && !wasVisible.current
    wasVisible.current = visible
    if (appeared) {
      setCollapsed(false)
      setEpoch((n) => n + 1)
    }
  }, [visible])

  useEffect(() => {
    if (!visible || collapsed || held) return
    const timer = setTimeout(() => setCollapsed(true), delayMs)
    return () => clearTimeout(timer)
  }, [visible, collapsed, held, epoch, delayMs])

  const release = () => {
    if (!pointerInside.current && !focusInside.current) setHeld(false)
  }

  const expand = useCallback(() => {
    setCollapsed(false)
    setHeld(true)
  }, [])

  const collapse = useCallback(() => {
    pointerInside.current = false
    focusInside.current = false
    setHeld(false)
    setCollapsed(true)
  }, [])

  const peek = useCallback(() => {
    setCollapsed(false)
    setEpoch((n) => n + 1)
  }, [])

  return {
    collapsed,
    expand,
    collapse,
    peek,
    holdProps: {
      onPointerEnter: () => {
        pointerInside.current = true
        setHeld(true)
      },
      onPointerLeave: () => {
        pointerInside.current = false
        release()
      },
      onFocus: () => {
        focusInside.current = true
        setHeld(true)
      },
      onBlur: (event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null))
          return
        focusInside.current = false
        release()
      },
    },
  }
}
