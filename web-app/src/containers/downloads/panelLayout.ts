/**
 * ATO-462: where the download panel is allowed to sit.
 *
 * Pure and DOM-free so the placement rules can be tested directly — they are
 * the part most likely to regress when the surrounding layout changes.
 */

/** Distance kept between the panel and whatever it stacks against. */
export const GAP = 12
/** Distance from the window edge when nothing is in the way. */
export const EDGE = 16
/** Matches the `w-[min(22rem,...)]` the panel renders at. */
const PANEL_WIDTH = 352
/** Header plus list padding — the part of the panel that is not rows. */
const CHROME = 44
/** Below this there is no point squeezing the panel in under the composer. */
const MIN_USEFUL = 150

export type PanelLayout = {
  /** Distance from the window bottom, in px. */
  bottom: number
  /** Max height for the scrolling list, in px. */
  listMax: number
}

/**
 * Place the panel so it never covers the composer.
 *
 * The composer is centred on an empty screen and pinned to the bottom in a
 * thread, and in both cases it is as wide as the content column — so a panel
 * pinned to the bottom-right corner lands on the send button. Writing to a
 * model while it downloads is the point of ATO-460, so the composer wins:
 * where there is usable room beneath it the panel stays in the corner and
 * gives up height, and where there is none it sits above it instead.
 *
 * `anchorRect` is the composer; `viewport` is the window. Both are passed in so
 * this stays a pure function and can be tested without a DOM.
 */
export function panelLayout(
  anchorRect: {
    top: number
    bottom: number
    left: number
    right: number
    height: number
  } | null,
  viewport: { width: number; height: number }
): PanelLayout {
  // 13rem, or 30% of a short window.
  const cap = Math.min(208, Math.round(viewport.height * 0.3))
  const corner = { bottom: EDGE, listMax: cap }

  if (!anchorRect || anchorRect.height === 0) return corner

  const width = Math.min(PANEL_WIDTH, viewport.width - 2 * EDGE)
  const left = viewport.width - EDGE - width
  const sideBySide = anchorRect.right <= left || anchorRect.left >= left + width
  if (sideBySide) return corner

  const spaceBelow = viewport.height - EDGE - (anchorRect.bottom + GAP)
  if (spaceBelow >= MIN_USEFUL) {
    return { bottom: EDGE, listMax: Math.min(cap, spaceBelow - CHROME) }
  }

  // The composer is at the bottom of the window: sit above it.
  const bottom = viewport.height - anchorRect.top + GAP
  const spaceAbove = viewport.height - bottom - EDGE
  return {
    bottom,
    listMax: Math.max(80, Math.min(cap, spaceAbove - CHROME)),
  }
}
