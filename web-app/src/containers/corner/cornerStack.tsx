import { useLayoutEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { EDGE, panelLayout } from '@/containers/downloads/panelLayout'

/**
 * The bottom-right notification corner: the download panel, the update
 * banners, a managed engine's setup card, the model reminder and the
 * first-run handoff panel.
 *
 * Each of them used to pin itself to the corner and dodge the download panel
 * through a height it published (`--download-panel-offset`). Every card above
 * the panel used the same offset, so any two of them showing at once landed
 * on top of each other, and the engine's background-download card ignored the
 * offset altogether. Here they all render into one column instead: a card
 * takes the room it needs and the others move along, whatever is showing.
 *
 * The column keeps clear of the composer the way the download panel did
 * (`panelLayout`), for every card in it.
 */

/** Position in the column, top to bottom. Closest to the corner: downloads. */
export const CORNER_ORDER = {
  handoff: 10,
  reminder: 20,
  managedEngine: 30,
  update: 40,
  downloads: 50,
} as const

/** Max height of the download list, from `panelLayout`; set on the column. */
export const CORNER_LIST_MAX_VAR = '--corner-list-max'

const STACK_ATTR = 'data-corner-stack'

// z-40: above the first-run flow (z-30), below dialogs and their overlays
// (z-50). Only the cards take clicks; the gaps between them stay clickable.
const STACK_CLASS =
  'fixed right-4 z-40 flex max-w-[calc(100vw-2rem)] flex-col items-end gap-3 pointer-events-none transition-[bottom] duration-200 motion-reduce:transition-none'

let host: HTMLDivElement | null = null
let users = 0
let stopPlacement: (() => void) | null = null

/**
 * The column, created on first use. It hangs off `<body>`, the app-wide
 * overlay layer, so no route's stacking context can paint over a card.
 */
function cornerHost(): HTMLDivElement {
  if (host?.isConnected) return host
  host = document.createElement('div')
  host.setAttribute(STACK_ATTR, '')
  host.className = STACK_CLASS
  host.style.bottom = `${EDGE}px`
  document.body.append(host)
  return host
}

/**
 * Keep the column clear of the composer, and follow it as it grows with typed
 * text or moves between the centred empty state and the bottom of a thread.
 * Runs only while some card is showing.
 */
function startPlacement(column: HTMLDivElement): () => void {
  // `undefined` until the first look, so a screen without a composer still
  // gets its first measurement.
  let anchor: Element | null | undefined

  // Measured synchronously rather than in a `requestAnimationFrame`: rAF does
  // not run while the window is hidden, which would leave the column parked
  // over the composer until the next paint. Writing values that did not change
  // is a no-op, so the bursts a growing textarea produces cost a comparison.
  const measure = () => {
    // The expanded download panel gives up list height to fit; everything
    // else in the column keeps its size and only moves.
    // `data-corner-panel` marks it (`DownloadPanel`).
    const panel = column.querySelector<HTMLElement>('[data-corner-panel]')
    const next = panelLayout(
      anchor?.getBoundingClientRect() ?? null,
      { width: window.innerWidth, height: window.innerHeight },
      column.offsetWidth || undefined,
      {
        otherHeight: column.offsetHeight - (panel?.offsetHeight ?? 0),
        hasList: panel !== null,
      }
    )
    const bottom = `${next.bottom}px`
    if (column.style.bottom !== bottom) column.style.bottom = bottom
    const listMax = `${next.listMax}px`
    if (column.style.getPropertyValue(CORNER_LIST_MAX_VAR) !== listMax) {
      column.style.setProperty(CORNER_LIST_MAX_VAR, listMax)
    }
  }

  // The body, the composer and the column itself: a card collapsing to its
  // small version narrows the column, which can let it back into the corner.
  // Its position and list height settle in one pass, so this cannot loop.
  const observer = new ResizeObserver(measure)
  observer.observe(document.body)
  observer.observe(column)

  // Every screen mounts its own composer: the first message on the home
  // screen swaps the centred one for the new thread's, pinned to the bottom,
  // without resizing anything the observer watches. Follow the swap, or the
  // column stays in the corner over the new composer.
  const follow = () => {
    const next = document.querySelector('[data-composer-anchor]')
    if (next === anchor) return
    if (anchor) observer.unobserve(anchor)
    anchor = next
    if (anchor) observer.observe(anchor)
    measure()
  }
  follow()
  const swaps = new MutationObserver(follow)
  swaps.observe(document.body, { childList: true, subtree: true })
  window.addEventListener('resize', measure)

  return () => {
    observer.disconnect()
    swaps.disconnect()
    window.removeEventListener('resize', measure)
  }
}

/**
 * Registers a card that is showing and keeps the column placed while any card
 * is. Layout effect, so the first placement lands in the same paint as the
 * card.
 */
function useCornerPlacement(column: HTMLDivElement | null) {
  useLayoutEffect(() => {
    if (!column) return
    users += 1
    if (users === 1) stopPlacement = startPlacement(column)
    return () => {
      users -= 1
      if (users === 0) {
        stopPlacement?.()
        stopPlacement = null
      }
    }
  }, [column])
}

/**
 * Renders `children` into the corner column at `order`. Render it only while
 * the card shows: mounting it is what keeps the column placed.
 */
export function CornerSlot({
  order,
  children,
}: {
  order: number
  children: ReactNode
}) {
  const column = typeof document === 'undefined' ? null : cornerHost()
  useCornerPlacement(column)

  const slot = (
    <div className="pointer-events-auto max-w-full" style={{ order }}>
      {children}
    </div>
  )
  return column ? createPortal(slot, column) : slot
}
