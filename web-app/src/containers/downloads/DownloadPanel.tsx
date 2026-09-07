import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { IconChevronDown } from '@tabler/icons-react'
import { DownloadIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  DownloadProgressRow,
  type DownloadRowProps,
} from './DownloadProgressRow'
import { EDGE, GAP, panelLayout, type PanelLayout } from './panelLayout'

const COLLAPSED_STORAGE_KEY = 'download-panel-collapsed'

/**
 * Height the panel currently occupies in the bottom-right corner, published as
 * a CSS variable on `<html>`.
 *
 * `PromptOnboardingModel` and `PromptVisionModel` are pinned to the same
 * corner. Rather than have each of them know the panel exists, they offset
 * themselves by this variable, which is 0 whenever the panel is not showing.
 */
const OFFSET_VAR = '--download-panel-offset'

function readCollapsedPreference(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_STORAGE_KEY) === 'true'
  } catch {
    // Private mode / disabled storage: default to expanded, which is the
    // state the whole redesign exists to make the default.
    return false
  }
}

export type DownloadPanelProps = {
  items: DownloadRowProps[]
  /**
   * Reports the collapsed state, including the initial one restored from
   * storage, so the owner can measure how long the panel stayed expanded
   * without also owning the flag.
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
 * deliberate click, remembered across screens and restarts. Collapsed, it is
 * still a live badge with the number of active downloads rather than nothing.
 */
export function DownloadPanel({
  items,
  onCollapsedChange,
}: DownloadPanelProps) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(readCollapsedPreference)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [layout, setLayout] = useState<PanelLayout>({
    bottom: EDGE,
    listMax: 208,
  })

  const count = items.length
  const visible = count > 0

  // Keep clear of the composer, and follow it as it grows with typed text or
  // moves between the centred empty state and the bottom of a thread.
  useLayoutEffect(() => {
    if (!visible) return

    // Measured synchronously rather than in a `requestAnimationFrame`: rAF does
    // not run while the window is hidden, which would leave the panel parked
    // over the composer until the next paint. `setLayout` no-ops when nothing
    // moved, so the bursts a growing textarea produces cost a comparison each.
    const measure = () => {
      const element = document.querySelector('[data-composer-anchor]')
      const next = panelLayout(element?.getBoundingClientRect() ?? null, {
        width: window.innerWidth,
        height: window.innerHeight,
      })
      setLayout((current) =>
        current.bottom === next.bottom && current.listMax === next.listMax
          ? current
          : next
      )
    }
    measure()

    // Only the body and the composer are observed, never the panel, so
    // measuring can't feed back into another resize.
    const observer = new ResizeObserver(measure)
    observer.observe(document.body)
    const anchor = document.querySelector('[data-composer-anchor]')
    if (anchor) observer.observe(anchor)
    window.addEventListener('resize', measure)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [visible, collapsed])

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, String(collapsed))
    } catch {
      // Preference is a convenience; losing it must not break the panel.
    }
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
        className="fixed right-4 z-50"
        style={{ bottom: layout.bottom }}
      >
        <Button
          variant="secondary"
          size="icon"
          className="relative size-11 rounded-full shadow-lg"
          onClick={() => setCollapsed(false)}
          aria-label={t('common:downloadPanel.expand')}
          aria-expanded={false}
        >
          <DownloadIcon className="size-4 text-muted-foreground" />
          <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-emerald-500 text-[11px] font-semibold tabular-nums text-white">
            {count}
          </span>
        </Button>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        'fixed right-4 z-50 w-[min(22rem,calc(100vw-2rem))]',
        'select-none overflow-hidden rounded-2xl border bg-background text-sm shadow-lg'
      )}
      style={{ bottom: layout.bottom }}
      role="region"
      aria-label={t('common:downloads')}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        {/* The count is a pill rather than part of the sentence: the app's i18n
            layer does no plural selection, and "Downloading {{count}} items"
            would be wrong in every language that inflects. */}
        <p className="flex min-w-0 items-center gap-1.5 font-medium">
          <span className="truncate">{t('common:downloading')}</span>
          {count > 1 && (
            <span className="shrink-0 rounded-full bg-muted-foreground/15 px-1.5 text-xs tabular-nums text-muted-foreground">
              {count}
            </span>
          )}
        </p>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setCollapsed(true)}
          aria-label={t('common:downloadPanel.collapse')}
          aria-expanded
        >
          <IconChevronDown size={16} className="text-muted-foreground" />
        </Button>
      </div>
      {/* Height comes from `panelLayout`: whatever is left once the composer
          has its space. A longer queue scrolls rather than growing the panel.
          Realistic queues are one or two items — a model plus a backend
          binary — and those fit whole. */}
      <ul
        className="space-y-2 overflow-y-auto px-2 pb-2"
        style={{ maxHeight: layout.listMax }}
      >
        {items.map((item) => (
          <DownloadProgressRow key={item.id} {...item} />
        ))}
      </ul>
    </div>
  )
}
