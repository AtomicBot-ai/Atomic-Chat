import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ChatGptConnectionState } from '@/hooks/useChatGptAuth'

export type CloudSubscriptionCardProps = {
  state?: ChatGptConnectionState
  /** Account label shown once connected, e.g. `you@example.test (Plus)`. */
  account?: string
  /** Whatever the backend said went wrong, verbatim. */
  error?: string
  /** Models this connection puts in the picker while it is signed in. */
  modelCount?: number
  onConnectBrowser?: () => void
  onCancel?: () => void
  onDisconnect?: () => void
  /** Device-code grant is not implemented; see the ADR. */
  onDeviceCode?: () => void
}

/**
 * "ChatGPT subscription" — sign in with a ChatGPT account instead of an API key.
 *
 * Named for the subscription, not for Codex: the Integrations page already has
 * a "Codex CLI" card pointing that tool *at* our local server, which is the
 * opposite direction.
 *
 * The device-code button stays disabled until we can confirm the provider's
 * OAuth client implements RFC 8628 — a control that looks live and does nothing
 * is worse than one that is honestly labelled.
 */
export function CloudSubscriptionCard({
  state = 'unavailable',
  account,
  error,
  modelCount = 0,
  onConnectBrowser,
  onCancel,
  onDisconnect,
  onDeviceCode,
}: CloudSubscriptionCardProps) {
  const { t } = useTranslation()
  const available = state !== 'unavailable'
  const connected = state === 'connected'
  const connecting = state === 'connecting'

  const statusLabel = connected
    ? (account ?? t('cloud:connection.connected'))
    : connecting
      ? t('cloud:subscription.connecting')
      : t('cloud:connection.notConnected')

  const description = !available
    ? t('cloud:subscription.unavailable')
    : connecting
      ? t('cloud:subscription.browserHint')
      : (error ??
        (connected
          ? t('cloud:subscription.modelCount', { count: modelCount })
          : undefined))

  return (
    <Card
      header={
        <div className="mb-4 space-y-1">
          <h2 className="font-studio text-base font-medium text-foreground">
            {t('cloud:subscription.title')}
          </h2>
          <p className="text-muted-foreground">
            {t('cloud:subscription.description')}
          </p>
        </div>
      }
    >
      <CardItem
        title={
          <span className="flex items-center gap-2">
            <span
              data-testid="cloud-subscription-dot"
              className={
                connected
                  ? 'size-2 shrink-0 rounded-full bg-green-500'
                  : connecting
                    ? 'size-2 shrink-0 rounded-full bg-amber-500 motion-safe:animate-pulse'
                    : 'size-2 shrink-0 rounded-full bg-muted-foreground/50'
              }
            />
            {statusLabel}
          </span>
        }
        description={
          description ? (
            <span className={error && available && !connecting ? 'text-destructive' : undefined}>
              {description}
            </span>
          ) : undefined
        }
        align="start"
        actions={
          <div className="flex shrink-0 items-center gap-2">
            {connected ? (
              <Button variant="outline" size="sm" onClick={onDisconnect}>
                {t('cloud:connection.disconnect')}
              </Button>
            ) : connecting ? (
              <Button variant="outline" size="sm" onClick={onCancel}>
                {t('cloud:connection.cancel')}
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  disabled={!available || state === 'loading'}
                  onClick={onConnectBrowser}
                >
                  {t('cloud:subscription.connectInBrowser')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!available || !onDeviceCode}
                  onClick={onDeviceCode}
                >
                  {t('cloud:subscription.useDeviceCode')}
                </Button>
              </>
            )}
          </div>
        }
      />
    </Card>
  )
}
