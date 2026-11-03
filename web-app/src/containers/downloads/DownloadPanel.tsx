import { useTranslation } from '@/i18n/react-i18next-compat'
import { IconDownload } from '@tabler/icons-react'
import { useEffect, useLayoutEffect, useRef } from 'react'

import {
  CORNER_CARD,
  CornerCardHeader,
  CornerMini,
} from '@/containers/corner/CornerCard'
import {
  CORNER_LIST_MAX_VAR,
  CORNER_ORDER,
  CornerSlot,
} from '@/containers/corner/cornerStack'
import { useAutoCollapse } from '@/containers/corner/useAutoCollapse'

import {
  DownloadProgressRow,
  type DownloadRowProps,
} from './DownloadProgressRow'

export type DownloadPanelProps = {
  items: DownloadRowProps[]
  /**
   * Reports the collapsed state so the owner can measure how long the panel
   * stayed expanded without also owning the flag.
   */
  onCollapsedChange?: (collapsed: boolean) => void
}

/** Bytes done over bytes known, across the rows that know their size. */
function overallProgress(items: DownloadRowProps[]): number | null {
  let current = 0
  let total = 0
  for (const item of items) {
    if (item.total > 0) {
      current += Math.min(item.current, item.total)
      total += item.total
    }
  }
  return total > 0 ? current / total : null
}

/**
 * ATO-462: the download indicator, in the bottom-right corner column
 * (`corner/cornerStack`) with the other notification cards.
 *
 * It opens in full whenever a download starts — the file name, size and
 * progress are what the user needs to see right then — and folds into a pill
 * three seconds later, so a download that runs for minutes does not cover the
 * window. Folded, it is still live: the overall percent in a progress ring and
 * the number of running downloads, and one click opens it again. A download
 * that joins a running queue opens it for another three seconds, so nothing
 * starts unseen.
 */
export function DownloadPanel({
  items,
  onCollapsedChange,
}: DownloadPanelProps) {
  const { t } = useTranslation()
  const count = items.length
  const visible = count > 0
  const { collapsed, expand, collapse, peek, holdProps } =
    useAutoCollapse(visible)

  // A download joining the running queue shows itself. Not on the first rows:
  // those are an appearance, which `useAutoCollapse` already opens.
  const seenIds = useRef<Set<string>>(new Set(items.map((item) => item.id)))
  useLayoutEffect(() => {
    const seen = seenIds.current
    const joined = seen.size > 0 && items.some((item) => !seen.has(item.id))
    seenIds.current = new Set(items.map((item) => item.id))
    if (joined) peek()
  }, [items, peek])

  useEffect(() => {
    onCollapsedChange?.(collapsed)
  }, [collapsed, onCollapsedChange])

  if (!visible) return null

  if (collapsed) {
    const progress = overallProgress(items)
    return (
      <CornerSlot order={CORNER_ORDER.downloads}>
        <CornerMini
          icon={<IconDownload size={15} aria-hidden />}
          text={progress === null ? null : `${Math.round(progress * 100)}%`}
          progress={progress}
          count={count}
          label={t('common:downloadPanel.expand')}
          onClick={expand}
        />
      </CornerSlot>
    )
  }

  // The first-run handoff panel's shell (`onboarding/handoff.css`): one card,
  // the strips inside it divided by hairlines.
  return (
    <CornerSlot order={CORNER_ORDER.downloads}>
      <div
        className={CORNER_CARD}
        role="region"
        aria-label={t('common:downloads')}
        data-corner-panel=""
        {...holdProps}
      >
        <CornerCardHeader
          title={t('common:downloading')}
          count={count}
          collapseLabel={t('common:downloadPanel.collapse')}
          onCollapse={collapse}
        />
        {/* Height comes from `panelLayout`, through the column: whatever is
            left once the composer has its space. A longer queue scrolls
            rather than growing the panel. Realistic queues are one or two
            items — a model plus an engine build — and those fit whole. */}
        <ul
          className="divide-y divide-[var(--dl-divider)] overflow-y-auto"
          style={{ maxHeight: `var(${CORNER_LIST_MAX_VAR}, 208px)` }}
        >
          {items.map((item) => (
            <DownloadProgressRow key={item.id} {...item} />
          ))}
        </ul>
      </div>
    </CornerSlot>
  )
}
