import { useCallback, useEffect, useState } from 'react'
import { Laptop, Loader2, Server, Smartphone } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/containers/Card'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { accountErrorMessage, platformLabel } from '@/lib/account'
import { formatTimeAgo } from '@/lib/model-card'
import { toAccountError } from '@/services/account/errors'
import type { AccountError, AccountSession } from '@/services/account/types'
import { useAccountStore } from '@/stores/account-store'

const MOBILE_PLATFORMS = new Set(['ios', 'android'])

/** This device first, then the most recently used. */
function sortSessions(sessions: AccountSession[]): AccountSession[] {
  return [...sessions].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1
    return Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt)
  })
}

/** Every device the account is signed in on, with a way to sign each out. */
export function AccountDevices() {
  const { t, i18n } = useTranslation()
  const account = useServiceHub().account()

  const userId = useAccountStore((state) =>
    state.status.signedIn ? (state.status.user?.id ?? null) : null
  )
  const setDevices = useAccountStore((state) => state.setDevices)
  // The list from the last visit, shown while it is refreshed in place.
  const [sessions, setSessions] = useState<AccountSession[] | null>(() => {
    const cached = useAccountStore.getState().devices
    return cached && cached.userId === userId ? cached.sessions : null
  })
  const [loadError, setLoadError] = useState<AccountError | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<AccountError | null>(null)

  const load = useCallback(async () => {
    try {
      const list = sortSessions(await account.sessions())
      setSessions(list)
      setLoadError(null)
      if (userId) setDevices(userId, list)
    } catch (raw) {
      setLoadError(toAccountError(raw))
    }
  }, [account, userId, setDevices])

  useEffect(() => {
    void load()
  }, [load])

  const revoke = async (session: AccountSession) => {
    setRevoking(session.id)
    setRevokeError(null)
    try {
      await account.revokeSession(session.id)
      await load()
    } catch (raw) {
      setRevokeError(toAccountError(raw))
    } finally {
      setRevoking(null)
    }
  }

  const deviceName = (session: AccountSession) => {
    if (session.deviceName?.trim()) return session.deviceName.trim()
    const platform = platformLabel(session.platform)
    return platform
      ? t('account:devices.platformDevice', { platform })
      : t('account:devices.unknownDevice')
  }

  const details = (session: AccountSession) =>
    [
      platformLabel(session.platform),
      session.appVersion &&
        t(
          session.clientType === 'server'
            ? 'account:devices.serverVersion'
            : 'account:devices.appVersion',
          { version: session.appVersion }
        ),
      t('account:devices.lastUsed', {
        time:
          formatTimeAgo(session.lastUsedAt, i18n?.language) ??
          session.lastUsedAt,
      }),
    ]
      .filter(Boolean)
      .join(' · ')

  return (
    <Card title={t('account:devices.title')}>
      <p className="-mt-1.5 mb-3 text-muted-foreground">
        {t('account:devices.description')}
      </p>

      {sessions === null && !loadError && (
        // One row shaped like a device row (this device is always listed),
        // with the same type, so the card keeps its height when it loads.
        <div
          className="flex min-w-0 items-center gap-3"
          data-testid="account-devices-loading"
          aria-hidden
        >
          <span className="size-8 shrink-0 animate-pulse rounded-lg bg-foreground/8" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              <span className="inline-block w-40 animate-pulse rounded bg-foreground/8 leading-none">
                &nbsp;
              </span>
            </div>
            <div>
              <span className="inline-block w-56 animate-pulse rounded bg-foreground/8 leading-none">
                &nbsp;
              </span>
            </div>
          </div>
        </div>
      )}

      {loadError && (
        <div className="flex min-w-0 items-center justify-between gap-3">
          <span role="alert" className="min-w-0 text-destructive">
            {accountErrorMessage(t, loadError)}
          </span>
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={() => void load()}
          >
            {t('account:devices.retry')}
          </Button>
        </div>
      )}

      {sessions && !loadError && (
        <ul className="flex flex-col" data-testid="account-devices">
          {sessions.map((session) => {
            const Icon =
              session.clientType === 'server'
                ? Server
                : session.clientType === 'mobile' ||
                    MOBILE_PLATFORMS.has((session.platform ?? '').toLowerCase())
                  ? Smartphone
                  : Laptop
            return (
              <li
                key={session.id}
                className="flex min-w-0 items-center gap-3 border-b border-border/40 py-2.5 first:pt-0 last:border-none last:pb-0"
                data-testid="account-device"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/8 text-foreground">
                  <Icon size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium text-foreground">
                      {deviceName(session)}
                    </span>
                    {session.current && (
                      <span className="shrink-0 rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-medium leading-none text-emerald-700 dark:text-emerald-300">
                        {t('account:devices.thisDevice')}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-muted-foreground">
                    {details(session)}
                  </div>
                </div>
                {/* One action column: rows keep their width either way. */}
                <div className="flex w-24 shrink-0 justify-end">
                  {!session.current && (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="min-w-20"
                      disabled={revoking !== null}
                      onClick={() => void revoke(session)}
                      aria-label={t('account:devices.signOutDevice', {
                        name: deviceName(session),
                      })}
                    >
                      {revoking === session.id && (
                        <Loader2 className="animate-spin" />
                      )}
                      {t('account:devices.signOut')}
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {revokeError && (
        <p role="alert" className="mt-2 text-destructive">
          {accountErrorMessage(t, revokeError)}
        </p>
      )}
    </Card>
  )
}
