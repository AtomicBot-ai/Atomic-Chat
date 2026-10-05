import { useState } from 'react'
import { IconArchive, IconChevronDown, IconChevronUp } from '@tabler/icons-react'

import { useTranslation } from '@/i18n/react-i18next-compat'
import type { CompactionEvent } from '@/lib/context-compaction'

type CompactionMarkerProps = {
  event: CompactionEvent
}

/**
 * Divider rendered where auto-compaction replaced older messages with a
 * model-written brief. Shows what happened at a glance and expands the
 * summary itself so users can always read what was condensed away.
 */
export function CompactionMarker({ event }: CompactionMarkerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <div className="my-2 flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        title={t('chat:compaction.hint')}
        className="flex items-center gap-1.5 rounded-md px-2 py-0.5 text-muted-foreground hover:text-foreground text-xs transition-colors cursor-pointer"
      >
        <IconArchive size={14} stroke={1.5} />
        <span>{t('chat:compaction.label')}</span>
        {open ? (
          <IconChevronUp size={12} stroke={1.5} />
        ) : (
          <IconChevronDown size={12} stroke={1.5} />
        )}
      </button>
      {open && (
        <div className="w-full max-w-2xl rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {event.summary}
        </div>
      )}
    </div>
  )
}
