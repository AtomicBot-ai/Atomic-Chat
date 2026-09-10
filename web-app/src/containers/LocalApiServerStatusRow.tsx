import { IconArrowRight } from '@tabler/icons-react'
import { Link } from '@tanstack/react-router'
import { useMemo } from 'react'

import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { StatusDot } from '@/containers/api/ApiStatusIndicators'
import { CopyButton } from '@/containers/CopyButton'
import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useLocalApiServerControl } from '@/hooks/useLocalApiServerControl'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { getLocalApiServerUrl } from '@/utils/localApiServerControl'

/**
 * Compact stand-in for the old `LocalApiServerPanel` on the Integrations page.
 * Full controls and live traffic now live on the API screen; this row only
 * shows whether the server agents talk to is up, and links there.
 */
export function LocalApiServerStatusRow() {
  const { t } = useTranslation()
  const control = useLocalApiServerControl()
  const { serverStatus, activeModels } = useAppState()
  const { serverHost, serverPort, apiPrefix } = useLocalApiServer()

  const url = useMemo(
    () => getLocalApiServerUrl(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverHost, serverPort, apiPrefix]
  )

  const label =
    serverStatus === 'stopped'
      ? t('api:status.stopped')
      : serverStatus === 'pending'
        ? t('api:status.starting')
        : activeModels.length > 0
          ? t('api:status.ready')
          : t('api:status.noModel')

  const tone =
    serverStatus === 'stopped'
      ? 'idle'
      : serverStatus === 'pending'
        ? 'pending'
        : activeModels.length > 0
          ? 'ready'
          : 'idle'

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-card p-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2 text-sm text-foreground">
          <StatusDot tone={tone} />
          {label}
        </span>
        <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
          {url}
          <CopyButton text={url} />
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {!control.isRunning && (
          <Button
            size="sm"
            onClick={() => void control.start()}
            disabled={control.isBusy}
          >
            {t('api:actions.start')}
          </Button>
        )}
        <Button asChild variant="outline" size="sm">
          <Link to={route.api.index}>
            {t('common:api')}
            <IconArrowRight size={14} />
          </Link>
        </Button>
      </div>
    </div>
  )
}
