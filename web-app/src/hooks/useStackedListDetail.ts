import { useLayoutEffect, useRef, useState } from 'react'

/** How a list-beside-detail page divides its own width. */
export type ListDetailGeometry = {
  /** Width the list column takes beside the detail, px. */
  listWidth: number
  /** Padding and borders between the detail's edge and its text, px. */
  detailInset: number
  /**
   * The narrowest comfortable reading measure for the detail's text, in ems
   * of the page's own body text — so it grows with the interface font size.
   */
  detailMeasureEm: number
}

/**
 * Whether a page `width` px wide, set at `fontSize` px, must stack its list
 * and detail (list first, detail full-width on demand) because side by side
 * the detail would get less than its reading measure. An element that has no
 * box yet (jsdom, `display: none`) keeps the side-by-side default.
 */
export function isListDetailStacked(
  width: number,
  fontSize: number,
  { listWidth, detailInset, detailMeasureEm }: ListDetailGeometry
): boolean {
  if (!(width > 0) || !(fontSize > 0)) return false
  return width < listWidth + detailInset + detailMeasureEm * fontSize
}

/**
 * Measure the element under `ref` — the page's own box, not the window, so
 * an open sidebar counts — and say whether its list and detail must stack.
 * Measured before paint, so the first frame already has the right layout,
 * and again when the page resizes or the interface font size changes.
 */
export function useStackedListDetail<T extends HTMLElement>({
  listWidth,
  detailInset,
  detailMeasureEm,
}: ListDetailGeometry) {
  const ref = useRef<T>(null)
  const [stacked, setStacked] = useState(false)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return undefined
    const measure = () => {
      setStacked(
        isListDetailStacked(
          element.getBoundingClientRect().width,
          parseFloat(getComputedStyle(element).fontSize),
          { listWidth, detailInset, detailMeasureEm }
        )
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    // Settings → Interface sets the font size as `--font-size-base` on
    // <html>: it moves the breakpoint without resizing the page.
    const fontObserver = new MutationObserver(measure)
    fontObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    })
    return () => {
      observer.disconnect()
      fontObserver.disconnect()
    }
  }, [listWidth, detailInset, detailMeasureEm])

  return { ref, stacked }
}
