import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/containers/Card'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { accountErrorMessage, platformLabel } from '@/lib/account'
import { formatTimeAgo } from '@/lib/model-card'
import { toAccountError } from '@/services/account/errors'
import type {
  RemoteConnectionView,
  RemoteHostInfo,
} from '@/services/account/remote-types'
import type { AccountError } from '@/services/account/types'
import { useAccountRemoteStore } from '@/stores/account-remote-store'
import { DeviceIcon } from './ShareThisComputer'

/** Codes the pairing field explains better than the generic message. */
const PAIR_ERRORS: Record<string, string> = {
  invalid_code: 'account:remote.use.invalidCode',
  own_host: 'account:remote.use.ownHost',
  limit_reached: 'account:remote.use.limitReached',
}

function ConnectionState({ connection }: { connection: RemoteConnectionView }) {
  const { t } = useTranslation()
  if (connection.status === 'pending') {
    return (
      <span data-testid="connection-waiting">
        {connection.checkCode
          ? t('account:remote.use.confirmOnHost', {
              code: connection.checkCode,
              name: connection.hostName,
            })
          : t('account:remote.use.waiting')}
      </span>
    )
  }
  if (!connection.ready)
    return <span>{t('account:remote.use.connecting')}</span>
  return (
    <span className="text-emerald-700 dark:text-emerald-300">
      {connection.via === 'lan'
        ? t('account:remote.use.connectedLan')
        : t('account:remote.use.connectedInternet')}
    </span>
  )
}

/**
 * "Use models from your other computers": the account's hosts, each with a
 * way to connect (a request the host allows) or to stop, plus a field for a
 * code shown on a host. A connected computer becomes a provider by itself.
 */
export function OtherComputers() {
  const { t, i18n } = useTranslation()
  const account = useServiceHub().account()
  const connections = useAccountRemoteStore((state) => state.status.connections)
  const setStatus = useAccountRemoteStore((state) => state.setStatus)

  const [hosts, setHosts] = useState<RemoteHostInfo[] | null>(null)
  const [loadError, setLoadError] = useState<AccountError | null>(null)
  const [busyHost, setBusyHost] = useState<string | null>(null)
  const [actionError, setActionError] = useState<AccountError | null>(null)
  const [code, setCode] = useState('')
  const [pairing, setPairing] = useState(false)
  const [pairError, setPairError] = useState<AccountError | null>(null)

  const load = useCallback(async () => {
    try {
      setHosts((await account.remoteHosts()).filter((h) => !h.isSelf))
      setLoadError(null)
    } catch (raw) {
      setLoadError(toAccountError(raw))
    }
  }, [account])

  // Again whenever a connection appears, ends or changes state.
  const connectionKey = connections
    .map((c) => `${c.hostId}:${c.status}:${c.ready}`)
    .join(',')
  useEffect(() => {
    void load()
  }, [load, connectionKey])

  const run = async (hostId: string, action: () => Promise<unknown>) => {
    setBusyHost(hostId)
    setActionError(null)
    try {
      await action()
      setStatus(await account.remoteStatus())
    } catch (raw) {
      setActionError(toAccountError(raw))
    } finally {
      setBusyHost(null)
    }
  }

  const pair = async (event: FormEvent) => {
    event.preventDefault()
    if (!code.trim()) return
    setPairing(true)
    setPairError(null)
    try {
      await account.remotePair(code.trim())
      setCode('')
      setStatus(await account.remoteStatus())
    } catch (raw) {
      setPairError(toAccountError(raw))
    } finally {
      setPairing(false)
    }
  }

  const details = (host: RemoteHostInfo) =>
    [
      platformLabel(host.platform),
      host.online
        ? t('account:remote.use.online')
        : host.lastSeenAt
          ? t('account:remote.use.lastSeen', {
              time: formatTimeAgo(host.lastSeenAt, i18n?.language) ?? '',
            })
          : t('account:remote.use.offline'),
    ]
      .filter(Boolean)
      .join(' · ')

  return (
    <Card title={t('account:remote.use.title')}>
      <div className="-mt-1.5 mb-3 flex min-w-0 items-start justify-between gap-3">
        <p className="min-w-0">{t('account:remote.use.description')}</p>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label={t('account:remote.use.refresh')}
          title={t('account:remote.use.refresh')}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
        </Button>
      </div>

      {loadError && (
        <p role="alert" className="mb-3 text-destructive">
          {accountErrorMessage(t, loadError)}
        </p>
      )}

      {hosts === null && !loadError && (
        <div className="flex h-12 items-center" aria-hidden>
          <Loader2 className="animate-spin" />
        </div>
      )}

      {hosts && hosts.length === 0 && (
        <p className="mb-3" data-testid="no-hosts">
          {t('account:remote.use.noHosts')}
        </p>
      )}

      {hosts && hosts.length > 0 && (
        <ul className="mb-3 flex flex-col" data-testid="remote-hosts">
          {hosts.map((host) => {
            const connection = connections.find((c) => c.hostId === host.id)
            const busy = busyHost === host.id
            return (
              <li
                key={host.id}
                className="flex min-w-0 items-center gap-3 border-b border-border/40 py-2.5 first:pt-0 last:border-none"
                data-testid="remote-host"
              >
                <DeviceIcon
                  clientType={host.clientType}
                  platform={host.platform}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-foreground">
                    {host.name}
                  </div>
                  {/* The check code must stay readable: it wraps, never truncates. */}
                  <div
                    className={connection ? 'min-w-0 break-words' : 'truncate'}
                  >
                    {connection ? (
                      <ConnectionState connection={connection} />
                    ) : (
                      details(host)
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  {connection ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busyHost !== null}
                      onClick={() =>
                        void run(host.id, () =>
                          account.remoteDisconnect(host.id)
                        )
                      }
                    >
                      {busy && <Loader2 className="animate-spin" />}
                      {connection.status === 'pending'
                        ? t('account:remote.use.cancel')
                        : t('account:remote.use.disconnect')}
                    </Button>
                  ) : (
                    <>
                      {!host.online && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyHost !== null}
                          aria-label={t('account:remote.use.removeHost', {
                            name: host.name,
                          })}
                          onClick={() =>
                            void run(host.id, () =>
                              account.remoteRemoveHost(host.id)
                            )
                          }
                        >
                          {t('account:remote.use.remove')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        disabled={busyHost !== null}
                        onClick={() =>
                          void run(host.id, () =>
                            account.remoteRequest(host.id)
                          )
                        }
                      >
                        {busy && <Loader2 className="animate-spin" />}
                        {t('account:remote.use.connect')}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {actionError && (
        <p role="alert" className="mb-3 text-destructive">
          {accountErrorMessage(t, actionError)}
        </p>
      )}

      <form
        className="flex min-w-0 items-center gap-2 border-t border-border/40 pt-3"
        onSubmit={(event) => void pair(event)}
      >
        <Input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder={t('account:remote.use.codePlaceholder')}
          aria-label={t('account:remote.use.codeLabel')}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1"
          data-testid="pair-code-input"
        />
        <Button type="submit" size="sm" disabled={pairing || !code.trim()}>
          {pairing && <Loader2 className="animate-spin" />}
          {t('account:remote.use.pair')}
        </Button>
      </form>
      {pairError && (
        <p role="alert" className="mt-2 text-destructive">
          {accountErrorMessage(t, pairError, PAIR_ERRORS)}
        </p>
      )}
    </Card>
  )
}
