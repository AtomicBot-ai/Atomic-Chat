import { useId, useState } from 'react'
import { IconChevronRight } from '@tabler/icons-react'

import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  formatCompactionTokens,
  type ThreadCompaction,
} from '@/lib/context-compaction'
import { cn } from '@/lib/utils'

/**
 * The line in a thread's message list before the first message the model is
 * still sent after a compaction: the messages above it stay on the page, the
 * model gets their summary instead. "Show summary" opens what it was given.
 */
export function CompactionDivider({
  compaction,
}: {
  compaction: ThreadCompaction
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const summaryId = useId()
  const title = t('chat:contextCompaction.dividerTitle')
  const parts = [
    title,
    compaction.summarizedCount > 0
      ? t('chat:contextCompaction.dividerMessages', {
          count: compaction.summarizedCount,
        })
      : undefined,
    compaction.tokensBefore > 0 && compaction.tokensAfter > 0
      ? t('chat:contextCompaction.dividerTokens', {
          before: formatCompactionTokens(compaction.tokensBefore),
          after: formatCompactionTokens(compaction.tokensAfter),
        })
      : undefined,
  ].filter((part): part is string => Boolean(part))

  return (
    <div
      data-testid="compaction-divider"
      role="group"
      aria-label={title}
      className="my-4 px-4"
    >
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
        <span
          className="min-w-0 truncate tabular-nums"
          data-testid="compaction-divider-label"
        >
          {parts.join(' · ')}
        </span>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={summaryId}
          onClick={() => setOpen((value) => !value)}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-sm font-medium text-foreground/80 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <IconChevronRight
            aria-hidden="true"
            className={cn(
              'size-3.5 shrink-0 transition-transform',
              open && 'rotate-90'
            )}
          />
          <span className="whitespace-nowrap">
            {open
              ? t('chat:contextCompaction.hideSummary')
              : t('chat:contextCompaction.showSummary')}
          </span>
        </button>
        <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
      </div>
      <div
        id={summaryId}
        hidden={!open}
        className="mt-2 max-h-72 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-sm leading-relaxed break-words whitespace-pre-wrap text-muted-foreground"
      >
        {compaction.summary}
      </div>
    </div>
  )
}
