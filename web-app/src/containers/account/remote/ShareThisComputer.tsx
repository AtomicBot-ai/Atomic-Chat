import { useState } from 'react'
import { Laptop, Loader2, Server, Smartphone } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Card } from '@/containers/Card'
import { useLocalApiServerControl } from '@/hooks/useLocalApiServerControl'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { accountErrorMessage, platformLabel } from '@/lib/account'
import { formatTimeAgo } from '@/lib/model-card'
import { toAccountError } from '@/services/account/errors'
import type { RemoteReach, RemoteStatus } from '@/services/account/remote-types'
import type { AccountError } from '@/services/account/types'
import { useAccountRemoteStore } from '@/stores/account-remote-store'
import { AddDeviceDialog } from './AddDeviceDialog'
import { useSharing } from './useSharing'

const MOBILE = new Set(['ios', 'android'])

export function DeviceIcon({
  clientType,
  platform,
}: {
  clientType?: string | null
  platform?: string | null
}) {
  const Icon =
    clientType === 'server'
      ? Server
      : clientType === 'mobile' || MOBILE.has((platform ?? '').toLowerCase())
        ? Smartphone
        : Laptop
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/8 text-foreground">
      <Icon size={16} />
    </span>
  )
}

/** How others reach this computer now, as one line. */
function reachKey(reach: RemoteReach | null): {
  key: string
  tone: 'ok' | 'wait' | 'warn'
} {
  if (!reach || !reach.serverRunning)
    return { key: 'account:remote.share.reach.serverStopped', tone: 'warn' }
  if (reach.tunnel === 'online')
    return {
      key: reach.lan
        ? 'account:remote.share.reach.internetAndLan'
        : 'account:remote.share.reach.internet',
      tone: 'ok',
    }
  if (reach.tunnel === 'starting')
    return { key: 'account:remote.share.reach.starting', tone: 'wait' }
  if (reach.lan)
    return { key: 'account:remote.share.reach.lanOnly', tone: 'ok' }
  if (reach.tunnel === 'error')
    return { key: 'account:remote.share.reach.tunnelError', tone: 'warn' }
  return { key: 'account:remote.share.reach.unreachable', tone: 'warn' }
}

const TONE_DOT = {
  ok: 'bg-emerald-500',
  wait: 'bg-amber-500 animate-pulse',
  warn: 'bg-destructive',
} as const

function ReachLine({ status }: { status: RemoteStatus }) {
  const { t } = useTranslation()
  const { key, tone } = reachKey(status.reach)
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="share-reach">
      <span className={`size-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
      <span className="min-w-0 truncate">{t(key)}</span>
    </div>
  )
}

/**
 * "Share this computer's models": the switch, how the computer is reached,
 * devices asking for access, and devices that have it.
 */
export function ShareThisComputer() {
  const { t, i18n } = useTranslation()
  const account = useServiceHub().account()
  const status = useAccountRemoteStore((state) => state.status)
  const setStatus = useAccountRemoteStore((state) => state.setStatus)
  const control = useLocalApiServerControl()
  const sharing = useSharing(control)

  const [adding, setAdding] = useState(false)
  const [busyGrant, setBusyGrant] = useState<string | null>(null)
  const [actionError, setActionError] = useState<AccountError | null>(null)

  const act = async (grantId: string, run: () => Promise<RemoteStatus>) => {
    setBusyGrant(grantId)
    setActionError(null)
    try {
      setStatus(await run())
    } catch (raw) {
      setActionError(toAccountError(raw))
    } finally {
      setBusyGrant(null)
    }
  }

  const deviceName = (name: string | null, platform: string | null) =>
    name?.trim() ||
    (platformLabel(platform)
      ? t('account:devices.platformDevice', {
          platform: platformLabel(platform),
        })
      : t('account:remote.unknownDevice'))

  const sharingError =
    sharing.error === 'server'
      ? t('account:remote.share.serverFailed')
      : sharing.error
        ? accountErrorMessage(t, sharing.error)
        : null

  return (
    <Card title={t('account:remote.share.title')}>
      <div className="flex min-w-0 items-start justify-between gap-5">
        <p className="min-w-0 -mt-1.5">
          {t('account:remote.share.description')}
        </p>
        <Switch
          checked={status.sharing}
          loading={sharing.working}
          disabled={sharing.working}
          aria-label={t('account:remote.share.toggle')}
          data-testid="share-switch"
          onCheckedChange={(next) =>
            next ? sharing.enable() : void sharing.disable()
          }
        />
      </div>

      {sharingError && (
        <p role="alert" className="mt-2 text-destructive">
          {sharingError}
        </p>
      )}

      {status.sharing && (
        <div className="mt-3 flex flex-col gap-3 border-t border-border/40 pt-3">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <ReachLine status={status} />
            <Button
              size="sm"
              className="shrink-0"
              onClick={() => setAdding(true)}
              data-testid="add-device"
            >
              {t('account:remote.share.addDevice')}
            </Button>
          </div>
          {status.reach &&
            status.reach.serverRunning &&
            !status.reach.serverHasKey && (
              <p role="alert" className="text-destructive">
                {t('account:remote.share.noServerKey')}
              </p>
            )}
          {status.hostError && (
            <p role="alert" className="text-destructive">
              {t('account:remote.share.syncError', {
                reason: status.hostError,
              })}
            </p>
          )}

          {status.requests.length > 0 && (
            <section aria-label={t('account:remote.share.requestsTitle')}>
              <h2 className="mb-1.5 font-medium text-foreground">
                {t('account:remote.share.requestsTitle')}
              </h2>
              <ul className="flex flex-col">
                {status.requests.map((request) => (
                  <li
                    key={request.grantId}
                    className="flex min-w-0 items-center gap-3 border-b border-border/40 py-2.5 first:pt-0 last:border-none last:pb-0"
                    data-testid="remote-request"
                  >
                    <DeviceIcon
                      clientType={request.clientType}
                      platform={request.platform}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-foreground">
                        {deviceName(request.deviceName, request.platform)}
                      </div>
                      <div className="truncate">
                        {t('account:remote.share.checkCode', {
                          code: request.checkCode,
                        })}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busyGrant !== null}
                        onClick={() =>
                          void act(request.grantId, () =>
                            account.remoteDecide(request.grantId, false)
                          )
                        }
                      >
                        {t('account:remote.share.deny')}
                      </Button>
                      <Button
                        size="sm"
                        disabled={busyGrant !== null}
                        onClick={() =>
                          void act(request.grantId, () =>
                            account.remoteDecide(request.grantId, true)
                          )
                        }
                      >
                        {busyGrant === request.grantId && (
                          <Loader2 className="animate-spin" />
                        )}
                        {t('account:remote.share.allow')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-label={t('account:remote.share.devicesTitle')}>
            <h2 className="mb-1.5 font-medium text-foreground">
              {t('account:remote.share.devicesTitle')}
            </h2>
            {status.devices.length === 0 ? (
              <p>{t('account:remote.share.noDevices')}</p>
            ) : (
              <ul className="flex flex-col">
                {status.devices.map((device) => (
                  <li
                    key={device.grantId}
                    className="flex min-w-0 items-center gap-3 border-b border-border/40 py-2.5 first:pt-0 last:border-none last:pb-0"
                    data-testid="remote-device"
                  >
                    <DeviceIcon platform={device.platform} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-foreground">
                        {deviceName(device.deviceName, device.platform)}
                      </div>
                      <div className="truncate">
                        {[
                          platformLabel(device.platform),
                          t('account:remote.share.since', {
                            time:
                              formatTimeAgo(
                                new Date(device.issuedAt * 1000).toISOString(),
                                i18n?.language
                              ) ?? '',
                          }),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                    <div className="flex w-24 shrink-0 justify-end">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="min-w-20"
                        disabled={busyGrant !== null}
                        aria-label={t('account:remote.share.revokeDevice', {
                          name: deviceName(device.deviceName, device.platform),
                        })}
                        onClick={() =>
                          void act(device.grantId, () =>
                            account.remoteRevoke(device.grantId)
                          )
                        }
                      >
                        {busyGrant === device.grantId && (
                          <Loader2 className="animate-spin" />
                        )}
                        {t('account:remote.share.revoke')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {actionError && (
        <p role="alert" className="mt-2 text-destructive">
          {accountErrorMessage(t, actionError)}
        </p>
      )}

      <AddDeviceDialog open={adding} onOpenChange={setAdding} />

      <Dialog
        open={sharing.keyPrompt}
        onOpenChange={(open) => !open && sharing.cancelKey()}
      >
        <DialogContent className="sm:max-w-md" data-testid="share-key-dialog">
          <DialogHeader>
            <DialogTitle>{t('account:remote.share.keyTitle')}</DialogTitle>
            <DialogDescription>
              {t('account:remote.share.keyDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={sharing.cancelKey}>
              {t('account:remote.share.keyCancel')}
            </Button>
            <Button onClick={sharing.confirmKey}>
              {t('account:remote.share.keyConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
