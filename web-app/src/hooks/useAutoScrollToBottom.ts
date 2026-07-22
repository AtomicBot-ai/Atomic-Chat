import { useCallback, useEffect, useRef } from 'react'

export interface AutoScrollOptions {
  /** While true, the element is continuously pinned to the bottom (e.g. while streaming). */
  enabled: boolean
  /** Distance from the bottom (px) still considered "at bottom". Default 8. */
  threshold?: number
  /**
   * Lag (px) above which we abandon easing and snap instantly to catch up.
   * Prevents the asymptotic ease from falling behind during fast streams.
   * Default 50.
   */
  catchUpThreshold?: number
  /** Ease per frame, 0..1. Higher = snappier, lower = smoother glide. Default 0.4. */
  ease?: number
  /** When true, streaming content keeps following even if layout reflow moves scrollTop upward. */
  forceStick?: boolean
}

/**
 * Keeps a scrollable element smoothly glued to its bottom while `enabled`
 * is true, without ever falling behind or stopping on collapse/un‑collapse.
 *
 * Uses per-frame exponential easing for a continuous glide, but snaps instantly
 * whenever the lag exceeds `catchUpThreshold` so it never gets stuck.
 * Reads `ref.current` fresh every frame so remounts (collapse/un‑collapse)
 * are handled automatically, and skips pinning when the element is hidden
 * (display:none) to avoid wasted work and stale scrollTop.
 */
export function useAutoScrollToBottom<T extends HTMLElement = HTMLDivElement>(
  ref: React.RefObject<T | null>,
  options: AutoScrollOptions
) {
  const stickRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const manualScrollRef = useRef(false)
  const manualScrollTimerRef = useRef<number | null>(null)
  const touchYRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const threshold = options.threshold ?? 8
  const catchUp = options.catchUpThreshold ?? 50
  const ease = options.ease ?? 0.4
  const forceStick = options.forceStick ?? false

  const isAtBottom = useCallback(
    (el: T) => el.scrollHeight - el.scrollTop - el.clientHeight <= threshold,
    [threshold]
  )

  const handleScroll = useCallback(() => {
    const el = ref.current
    if (!el) return

    const current = el.scrollTop
    if (forceStick) {
      if (isAtBottom(el)) {
        stickRef.current = true
      } else if (
        manualScrollRef.current &&
        current < lastScrollTopRef.current - 1
      ) {
        stickRef.current = false
      }
      lastScrollTopRef.current = current
      return
    }

    if (current < lastScrollTopRef.current - 1) {
      stickRef.current = false
    } else if (isAtBottom(el)) {
      stickRef.current = true
    }
    lastScrollTopRef.current = current
  }, [ref, isAtBottom, forceStick])

  useEffect(() => {
    if (!options.enabled) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      return
    }

    const isVisible = (el: T) =>
      el.getClientRects().length > 0 && el.clientHeight > 0

    const markManualScroll = () => {
      manualScrollRef.current = true
      if (manualScrollTimerRef.current != null) {
        window.clearTimeout(manualScrollTimerRef.current)
      }
      manualScrollTimerRef.current = window.setTimeout(() => {
        manualScrollRef.current = false
        manualScrollTimerRef.current = null
      }, 350)
    }

    let inputEl: T | null = null
    let cleanupInput = () => {}

    const syncManualInputListeners = (el: T | null) => {
      if (!forceStick || inputEl === el) return
      cleanupInput()
      inputEl = el
      if (!el) return

      const handleWheel = (event: WheelEvent) => {
        markManualScroll()
        if (event.deltaY < 0) stickRef.current = false
      }
      const handleTouchStart = (event: TouchEvent) => {
        markManualScroll()
        touchYRef.current = event.touches[0]?.clientY ?? 0
      }
      const handleTouchMove = (event: TouchEvent) => {
        markManualScroll()
        const nextY = event.touches[0]?.clientY ?? touchYRef.current
        if (nextY > touchYRef.current + 1) stickRef.current = false
        touchYRef.current = nextY
      }
      const handlePointerDown = () => markManualScroll()
      const handlePointerMove = () => markManualScroll()

      el.addEventListener('wheel', handleWheel, { passive: true })
      el.addEventListener('touchstart', handleTouchStart, { passive: true })
      el.addEventListener('touchmove', handleTouchMove, { passive: true })
      el.addEventListener('pointerdown', handlePointerDown, { passive: true })
      el.addEventListener('pointermove', handlePointerMove, { passive: true })

      cleanupInput = () => {
        el.removeEventListener('wheel', handleWheel)
        el.removeEventListener('touchstart', handleTouchStart)
        el.removeEventListener('touchmove', handleTouchMove)
        el.removeEventListener('pointerdown', handlePointerDown)
        el.removeEventListener('pointermove', handlePointerMove)
      }
    }

    const pinToBottom = (el: T) => {
      const max = el.scrollHeight - el.clientHeight
      el.scrollTop = max
      lastScrollTopRef.current = el.scrollTop
    }

    // Immediate pin on activation only when the element is actually visible
    // (not display:none / hidden tab). A hidden element drops scrollTop writes.
    const el = ref.current
    if (el && isVisible(el)) {
      stickRef.current = true
      pinToBottom(el)
    }

    let prevVisible = el ? isVisible(el) : false

    const tick = () => {
      const el = ref.current
      syncManualInputListeners(el)
      if (el) {
        const visible = isVisible(el)
        if (visible && !prevVisible) {
          // Just became visible (tab switch, un-collapse) - pin immediately
          // so the user never sees the top while content is streaming.
          stickRef.current = true
          pinToBottom(el)
        }
        prevVisible = visible

        if (visible && stickRef.current) {
          const max = el.scrollHeight - el.clientHeight
          const current = el.scrollTop
          const diff = max - current
          if (diff > threshold) {
            if (diff > catchUp) {
              // Lag too large - snap instantly so we never fall behind.
              el.scrollTop = max
            } else {
              const next = current + diff * ease
              el.scrollTop = next >= max - 0.5 ? max : next
            }
            lastScrollTopRef.current = el.scrollTop
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      cleanupInput()
      if (manualScrollTimerRef.current != null) {
        window.clearTimeout(manualScrollTimerRef.current)
        manualScrollTimerRef.current = null
      }
      manualScrollRef.current = false
      rafRef.current = null
    }
  }, [ref, options.enabled, threshold, catchUp, ease, forceStick])

  return { stickRef, handleScroll }
}
