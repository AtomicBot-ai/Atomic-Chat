import { Link } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'

import { route } from '@/constants/routes'
import { useApiServerLog } from '@/hooks/useApiServerLog'
import { useApiServerLogFeed } from '@/hooks/useApiServerLogFeed'
import { useApiServerModelNotices } from '@/hooks/useApiServerModelNotices'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ApiLogEntry } from '@/types/apiServerLog'
import { formatTime } from '@/utils/apiServerStats'

/** How many of the latest rows Overview lists before pointing at Activity. */
const LATEST = 8

function describeEntry(entry: ApiLogEntry, t: (key: string) => string): string {
  if (entry.kind === 'event') return entry.title
  const call = `${entry.method} /${entry.endpoint}`
  const model = entry.model ? ` · ${entry.model}` : ''
  const outcome =
    entry.status === 'in_flight'
      ? ` · ${t('api:overview.inFlight')}`
      : entry.status === 'error'
        ? ` · ${entry.httpStatus ?? t('api:overview.failed')}`
        : ''
  return `${call}${model}${outcome}`
}

/**
 * Overview's "Server activity & logs": the latest requests and model events,
 * newest first, with the way to the full Activity page. Like Activity it
 * listens to the request channel while it is on screen.
 */
export function ServerActivityPanel() {
  const { t } = useTranslation()
  useApiServerLogFeed()
  useApiServerModelNotices()
  const entries = useApiServerLog((state) => state.entries)
  const latest = entries.slice(0, LATEST)

  return (
    <details className="sp-panel sp-activity">
      <summary>
        {t('api:overview.activityTitle')}
        <ChevronDown size={16} />
      </summary>
      {latest.length > 0 ? (
        <ul>
          {latest.map((entry) => (
            <li key={entry.id}>
              <span className="sp-log-dot" />
              <span title={describeEntry(entry, t)}>
                {describeEntry(entry, t)}
              </span>
              <small>{formatTime(entry.startedAt)}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p>{t('api:overview.noActivity')}</p>
      )}
      <div className="sp-actions">
        <Link to={route.api.activity} className="sp-button">
          {t('api:overview.openActivity')}
        </Link>
      </div>
    </details>
  )
}
