import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { IconChevronDown, IconDownload } from '@tabler/icons-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  DownloadProgressRow,
  type DownloadRowProps,
} from './DownloadProgressRow'
import { EDGE, GAP, panelLayout, type PanelLayout } from './panelLayout'

/**
 * Height the panel currently occupies in the bottom-right corner, published as
 * a CSS variable on `<html>`.
 *
 * `PromptOnboardingModel` is pinned to the same corner. Rather than have it
 * know the panel exists, it offsets itself by this variable, which is 0
 * whenever the panel is not showing.
 */
const OFFSET_VAR = '--download-panel-offset'

export type DownloadPanelProps = {
  items: DownloadRowProps[]
  /**
   * Reports the collapsed state so the owner can measure how long the panel
   * stayed expanded without also owning the flag.
   */
  onCollapsedChange?: (collapsed: boolean) => void
}

/**
 * ATO-462: the download indicator.
 *
 * Replaces a 28px ring in the sidebar whose popover opened on download start
 * and auto-closed 3.5 seconds later — the only moment the file name, size and
 * progress were visible passed by itself, and getting it back meant
 * remembering the icon was there.
 *
 * Here the expanded panel is the default and it stays put; collapsing is a
 * deliberate click for the current download run. Collapsed, it is still a
 * live badge with the number of active downloads rather than nothing. Once
 * the queue becomes idle, the next run starts expanded again.
 */
export function DownloadPanel({
  items,
  onCollapsedChange,
}: DownloadPanelProps) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [layout, setLayout] = useState<PanelLayout>({
    bottom: EDGE,
    listMax: 208,
  })

  const count = items.length
  const visible = count > 0
  const wasVisibleRef = useRef(visible)

  // A collapse is intentional only for the current run. Reset at the next
  // idle-to-active transition so the first text or image download is visible
  // immediately, while another item joining the active queue stays collapsed.
  // A layout effect prevents the old badge state from reaching the screen.
  useLayoutEffect(() => {
    const startsNewRun = visible && !wasVisibleRef.current
    wasVisibleRef.current = visible
    if (startsNewRun && collapsed) setCollapsed(false)
  }, [visible, collapsed])

  // Keep clear of the composer, and follow it as it grows with typed text or
  // moves between the centred empty state and the bottom of a thread.
  useLayoutEffect(() => {
    if (!visible) return

    // `undefined` until the first look, so a screen without a composer still
    // gets its first measurement.
    let anchor: Element | null | undefined

    // Measured synchronously rather than in a `requestAnimationFrame`: rAF does
    // not run while the window is hidden, which would leave the panel parked
    // over the composer until the next paint. `setLayout` no-ops when nothing
    // moved, so the bursts a growing textarea produces cost a comparison each.
    const measure = () => {
      const next = panelLayout(anchor?.getBoundingClientRect() ?? null, {
        width: window.innerWidth,
        height: window.innerHeight,
      })
      setLayout((current) =>
        current.bottom === next.bottom && current.listMax === next.listMax
          ? current
          : next
      )
    }

    // Only the body and the composer are observed, never the panel, so
    // measuring can't feed back into another resize.
    const observer = new ResizeObserver(measure)
    observer.observe(document.body)

    // Every screen mounts its own composer: the first message on the home
    // screen swaps the centred one for the new thread's, pinned to the bottom,
    // without resizing anything the observer watches. Follow the swap, or the
    // panel stays in the corner over the new composer until something else —
    // collapsing and expanding it — makes it measure again.
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
  }, [visible, collapsed])

  useEffect(() => {
    onCollapsedChange?.(collapsed)
  }, [collapsed, onCollapsedChange])

  // Publish the occupied height so the other bottom-right widgets can sit above
  // it. `useLayoutEffect` so the offset lands in the same paint as the panel and
  // the widgets above it never visibly jump.
  useLayoutEffect(() => {
    const root = document.documentElement
    const element = containerRef.current
    if (!visible || !element) {
      root.style.removeProperty(OFFSET_VAR)
      return
    }

    const publish = () => {
      // Measured from the panel's own top edge rather than from its height, so
      // the widgets above it stay correct whether the panel is in the corner or
      // docked above the composer. `- EDGE` because they anchor at `1rem`.
      const top = element.getBoundingClientRect().top
      root.style.setProperty(
        OFFSET_VAR,
        `${Math.max(0, window.innerHeight - top + GAP - EDGE)}px`
      )
    }
    publish()

    const observer = new ResizeObserver(publish)
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty(OFFSET_VAR)
    }
    // `collapsed` matters as much as `visible`: the two states render different
    // elements, so without it the observer would keep watching the node that
    // was just unmounted and the published offset would be stuck at the height
    // of the state we left.
  }, [visible, collapsed, layout])

  if (!visible) return null

  if (collapsed) {
    return (
      <div
        ref={containerRef}
        className="dl-panel fixed right-4 z-50"
        style={{ bottom: layout.bottom }}
      >
        <button
          type="button"
          className="relative grid size-11 cursor-pointer place-items-center rounded-full border border-[var(--dl-panel-line)] bg-[var(--dl-row)] text-[var(--dl-strong)] shadow-[var(--dl-panel-shadow)]"
          onClick={() => setCollapsed(false)}
          aria-label={t('common:downloadPanel.expand')}
          aria-expanded={false}
        >
          <IconDownload size={18} aria-hidden />
          <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-[var(--dl-progress)] text-[11px] font-semibold tabular-nums text-[var(--dl-badge-text)]">
            {count}
          </span>
        </button>
      </div>
    )
  }

  // The first-run handoff panel's shell (`onboarding/handoff.css`): one card,
  // the strips inside it divided by hairlines.
  return (
    <div
      ref={containerRef}
      className={cn(
        'dl-panel fixed right-4 z-50 w-[min(22rem,calc(100vw-2rem))]',
        'select-none overflow-hidden rounded-[15px] border border-[var(--dl-panel-line)] bg-[var(--dl-panel-bg)] text-sm text-[var(--dl-title)] shadow-[var(--dl-panel-shadow)]'
      )}
      style={{ bottom: layout.bottom }}
      role="region"
      aria-label={t('common:downloads')}
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--dl-divider)] py-2 pl-4 pr-3">
        {/* The count is a pill rather than part of the sentence: the app's i18n
            layer does no plural selection, and "Downloading {{count}} items"
            would be wrong in every language that inflects. */}
        <p className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
          <span className="truncate">{t('common:downloading')}</span>
          {count > 1 && (
            <span className="shrink-0 rounded-full bg-[var(--dl-track)] px-1.5 text-xs tabular-nums text-[var(--dl-strong)]">
              {count}
            </span>
          )}
        </p>
        <button
          type="button"
          className="grid size-7 cursor-pointer place-items-center rounded-full text-[var(--dl-text)] transition-colors hover:bg-[var(--dl-icon-hover)]"
          onClick={() => setCollapsed(true)}
          aria-label={t('common:downloadPanel.collapse')}
          aria-expanded
        >
          <IconChevronDown size={16} aria-hidden />
        </button>
      </div>
      {/* Height comes from `panelLayout`: whatever is left once the composer
          has its space. A longer queue scrolls rather than growing the panel.
          Realistic queues are one or two items — a model plus a backend
          binary — and those fit whole. */}
      <ul
        className="divide-y divide-[var(--dl-divider)] overflow-y-auto"
        style={{ maxHeight: layout.listMax }}
      >
        {items.map((item) => (
          <DownloadProgressRow key={item.id} {...item} />
        ))}
      </ul>
    </div>
  )
}
