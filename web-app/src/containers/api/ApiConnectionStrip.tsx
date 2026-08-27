import { IconWorld } from '@tabler/icons-react'
import { useMemo } from 'react'

import { CopyButton } from '@/containers/CopyButton'
import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { getModelContextLength } from '@/utils/apiServerCapacity'
import { formatCount } from '@/utils/apiServerStats'
import { getLocalApiServerUrl } from '@/utils/localApiServerControl'

import { MicroLabel, StatusDot, type StatusTone } from './ApiStatusIndicators'

function Field({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <MicroLabel>{label}</MicroLabel>
      <div className="mt-0.5 text-sm text-foreground">{children}</div>
    </div>
  )
}

export function ApiConnectionStrip() {
  const { t } = useTranslation()
  const { serverStatus, activeModels } = useAppState()
  const { serverHost, serverPort, apiPrefix } = useLocalApiServer()

  const url = useMemo(
    () => getLocalApiServerUrl(),
    // Recompute when any part of the address changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverHost, serverPort, apiPrefix]
  )

  const loadedModel = activeModels[0] ?? null
  const contextLength = getModelContextLength(loadedModel)

  const { tone, label }: { tone: StatusTone; label: string } =
    serverStatus === 'stopped'
      ? { tone: 'idle', label: t('api:status.stopped') }
      : serverStatus === 'pending'
        ? { tone: 'pending', label: t('api:status.starting') }
        : loadedModel
          ? { tone: 'ready', label: t('api:status.ready') }
          : { tone: 'idle', label: t('api:status.noModel') }

  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-lg border border-border bg-card px-4 py-3">
      <IconWorld size={18} className="shrink-0 text-muted-foreground" />

      <Field label={t('api:strip.baseUrl')}>
        <span className="flex items-center gap-1 font-mono text-xs">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {url}
          </a>
          <CopyButton text={url} />
        </span>
      </Field>

      <Field label={t('api:strip.status')}>
        <span className="flex items-center gap-1.5">
          <StatusDot tone={tone} />
          {label}
        </span>
      </Field>

      <Field label={t('api:strip.loadedModel')} className="flex-1">
        <span className="block truncate" title={loadedModel ?? undefined}>
          {loadedModel ?? (
            <span className="text-muted-foreground">
              {t('api:strip.noModel')}
            </span>
          )}
          {loadedModel && contextLength ? (
            <span className="text-muted-foreground">
              {' · '}
              {t('api:strip.ctx', { count: formatCount(contextLength) })}
            </span>
          ) : null}
        </span>
      </Field>
    </div>
  )
}
