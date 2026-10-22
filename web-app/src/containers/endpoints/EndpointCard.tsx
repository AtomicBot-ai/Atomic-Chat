import type { ReactNode } from 'react'
import {
  ChevronDown,
  CircleCheck,
  Loader2,
  Network,
  Radio,
  Settings2,
  Trash2,
  TriangleAlert,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { LocalModelCollisionNotice } from '@/containers/endpoints/LocalModelCollisionNotice'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { listedModels } from '@/lib/cloud-model-catalog'
import { isProviderConnected } from '@/lib/cloud-providers'
import { isMediaConnected } from '@/lib/media-models'
import { cn, getProviderLogo, getProviderTitle } from '@/lib/utils'
import { useEndpointCheckStore } from '@/stores/endpoint-check-store'
import { useProviderKeyStatus } from '@/stores/provider-key-status-store'

type EndpointCardProps = {
  provider: ProviderObject
  expanded: boolean
  onToggleExpanded: () => void
  /** A server that only makes media connects by listing its media models. */
  connectingMedia?: boolean
  onConnectMedia: () => void
  onPing: () => void
  onConfigure: () => void
  /** Absent for a provider the catalogue ships: only one's own can go. */
  onRemove?: () => void
  /** The endpoint's model cards, shown while expanded; none, no toggle. */
  children?: ReactNode
}

/**
 * One endpoint on Custom Endpoint: who it is, where it is, how it last
 * answered, and its actions. Expanding it shows its models — the chat list
 * (add, edit capabilities, remove, favourite) and its media models.
 */
export function EndpointCard({
  provider,
  expanded,
  onToggleExpanded,
  connectingMedia = false,
  onConnectMedia,
  onPing,
  onConfigure,
  onRemove,
  children,
}: EndpointCardProps) {
  const { t } = useTranslation()
  const name = provider.provider
  const title = getProviderTitle(name)
  const check = useEndpointCheckStore((s) => s.results[name])
  const checking = useEndpointCheckStore((s) => Boolean(s.checking[name]))

  const mediaServer = provider.media_only === true
  const modelCount = mediaServer
    ? (provider.media?.models.length ?? 0)
    : listedModels(provider).length
  const modelsLabel = (count: number) =>
    count === 0
      ? t('cloud:models.countNone')
      : count === 1
        ? t('cloud:models.countOne')
        : t('cloud:models.count', { count })
  const connected = isProviderConnected(provider) || isMediaConnected(provider)
  // A saved key the server refused, or one it could not be asked about.
  const keyStatus = useProviderKeyStatus(provider)
  const keyState = connected ? keyStatus?.state : undefined
  const hasAddress = Boolean(provider.base_url?.trim())
  const bodyId = `endpoint-models-${name}`

  let status: ReactNode
  if (checking) {
    status = (
      <>
        <Loader2 size={12} className="shrink-0 animate-spin" aria-hidden />
        <span className="truncate">{t('endpoints:status.checking')}</span>
      </>
    )
  } else if (check?.ok) {
    status = (
      <>
        <CircleCheck
          size={12}
          className="shrink-0 text-emerald-500"
          aria-hidden
        />
        <span className="truncate">
          {t('endpoints:status.reachable', {
            latency: check.latencyMs,
            models: modelsLabel(check.modelCount),
          })}
        </span>
      </>
    )
  } else if (check) {
    status = (
      <>
        <TriangleAlert
          size={12}
          className="shrink-0 text-destructive"
          aria-hidden
        />
        <span className="line-clamp-2 break-words" title={check.message}>
          {t('endpoints:status.failed')}
          {check.message ? ` · ${check.message}` : ''}
        </span>
      </>
    )
  } else if (keyState && keyStatus) {
    status = (
      <>
        <TriangleAlert
          size={12}
          className={cn(
            'shrink-0',
            keyState === 'rejected' ? 'text-destructive' : 'text-amber-500'
          )}
          aria-hidden
        />
        <span className="line-clamp-2 break-words" title={keyStatus.message}>
          {keyState === 'rejected'
            ? t('endpoints:status.keyRejected')
            : t('endpoints:status.unverified')}
          {keyStatus.message ? ` · ${keyStatus.message}` : ''}
        </span>
      </>
    )
  } else if (connected) {
    status = (
      <>
        <span
          className="size-2 shrink-0 rounded-full bg-green-500"
          aria-hidden
        />
        <span className="truncate">
          {t('endpoints:status.connected', { models: modelsLabel(modelCount) })}
        </span>
      </>
    )
  } else {
    status = (
      <span className="truncate">{t('endpoints:status.notChecked')}</span>
    )
  }

  return (
    <article
      aria-label={title}
      className="min-w-0 rounded-xl border border-border bg-card"
    >
      <div className="flex flex-wrap items-center gap-4 p-4">
        <span className="flex size-6 shrink-0 items-center justify-center text-foreground">
          {getProviderLogo(name) ? (
            <ProvidersAvatar provider={provider} className="size-6" />
          ) : (
            <Network size={22} aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1 basis-48">
          <h2 className="truncate font-medium text-foreground">{title}</h2>
          <p
            className="truncate text-xs text-muted-foreground"
            title={provider.base_url}
          >
            {hasAddress ? provider.base_url : t('endpoints:noAddress')}
          </p>
          <p
            role="status"
            className={cn(
              'mt-2 flex min-w-0 items-center gap-1 text-xs text-muted-foreground',
              ((check && !check.ok) || (!check && keyState === 'rejected')) &&
                !checking &&
                'text-destructive'
            )}
          >
            {status}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {children && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={expanded}
              aria-controls={bodyId}
              aria-label={t('endpoints:actions.showModels', { name: title })}
              onClick={onToggleExpanded}
            >
              {mediaServer
                ? t('cloud:media.title')
                : t('endpoints:actions.models')}
              <ChevronDown
                size={14}
                aria-hidden
                className={cn(
                  'transition-transform motion-reduce:transition-none',
                  expanded && 'rotate-180'
                )}
              />
            </Button>
          )}
          {mediaServer ? (
            <Button
              size="sm"
              variant="outline"
              disabled={connectingMedia || !hasAddress}
              onClick={onConnectMedia}
              data-testid="cloud-media-server-connect"
            >
              {connectingMedia ? (
                <Loader2 size={13} className="animate-spin" aria-hidden />
              ) : (
                <Radio size={13} aria-hidden />
              )}
              {connected
                ? t('cloud:models.reload')
                : t('cloud:connection.connect')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={checking || !hasAddress}
              onClick={onPing}
            >
              <Radio size={13} aria-hidden />
              {t('endpoints:actions.ping')}
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('endpoints:actions.configure', { name: title })}
            onClick={onConfigure}
          >
            <Settings2 size={15} aria-hidden />
          </Button>
          {/* The slot stays when there is nothing to remove, so every row's
              actions line up in one column. */}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('endpoints:actions.remove', { name: title })}
            aria-hidden={!onRemove}
            tabIndex={onRemove ? undefined : -1}
            disabled={!onRemove}
            className={cn(!onRemove && 'invisible')}
            onClick={onRemove}
          >
            <Trash2 size={15} aria-hidden />
          </Button>
        </div>
      </div>
      {expanded && children && (
        <div id={bodyId} className="flex flex-col border-t border-border">
          {!mediaServer && (
            <div className="px-4 pt-3 empty:hidden">
              <LocalModelCollisionNotice
                endpoint={name}
                modelIds={listedModels(provider).map((m) => m.id)}
              />
            </div>
          )}
          {children}
        </div>
      )}
    </article>
  )
}
