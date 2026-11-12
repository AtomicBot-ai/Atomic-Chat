import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import QRCode from 'react-qr-code'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { accountErrorMessage, formatCountdown } from '@/lib/account'
import { toAccountError } from '@/services/account/errors'
import type { RemotePairing } from '@/services/account/remote-types'
import type { AccountError } from '@/services/account/types'
import { useAccountRemoteStore } from '@/stores/account-remote-store'

/**
 * "Add a device": a pairing code and its QR code, valid 10 minutes. The QR
 * carries a secret the account service never sees, so a scanned pairing
 * cannot be faked even by the service. The dialog notices when a device used
 * the code and says so.
 */
export function AddDeviceDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const account = useServiceHub().account()
  const devices = useAccountRemoteStore((state) => state.status.devices)

  const [pairing, setPairing] = useState<RemotePairing | null>(null)
  const [error, setError] = useState<AccountError | null>(null)
  const [now, setNow] = useState(() => Date.now() / 1000)
  const [added, setAdded] = useState<string | null>(null)
  // The devices there were when this code was opened.
  const known = useRef<Set<string>>(new Set())

  const create = useCallback(async () => {
    setError(null)
    setPairing(null)
    setAdded(null)
    known.current = new Set(
      useAccountRemoteStore.getState().status.devices.map((d) => d.grantId)
    )
    try {
      setPairing(await account.remotePairingCode())
      setNow(Date.now() / 1000)
    } catch (raw) {
      setError(toAccountError(raw))
    }
  }, [account])

  useEffect(() => {
    if (open) void create()
  }, [open, create])

  // A device that paired with this code shows up among the devices.
  useEffect(() => {
    if (!open || !pairing || added) return
    const fresh = devices.find((d) => !known.current.has(d.grantId))
    if (fresh) {
      setAdded(fresh.deviceName?.trim() || t('account:remote.unknownDevice'))
    }
  }, [open, pairing, added, devices, t])

  useEffect(() => {
    if (!open || !pairing || added) return
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => window.clearInterval(timer)
  }, [open, pairing, added])

  const close = (next: boolean) => {
    if (!next && pairing && !added) {
      // An unused code should not stay open on the account.
      void account.remoteClosePairingCode().catch(() => {})
    }
    if (!next) setPairing(null)
    onOpenChange(next)
  }

  const left = pairing ? pairing.expiresAt - now : 0
  const expired = pairing !== null && left <= 0

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-sm" data-testid="add-device-dialog">
        <DialogHeader>
          <DialogTitle>{t('account:remote.add.title')}</DialogTitle>
          <DialogDescription>
            {added
              ? t('account:remote.add.done', { name: added })
              : t('account:remote.add.description')}
          </DialogDescription>
        </DialogHeader>

        {added && (
          <div className="flex justify-center py-4 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 size={40} />
          </div>
        )}

        {!added && !pairing && !error && (
          <div className="flex h-60 items-center justify-center">
            <Loader2 className="animate-spin text-muted-foreground" />
          </div>
        )}

        {!added && error && (
          <p role="alert" className="text-destructive">
            {accountErrorMessage(t, error)}
          </p>
        )}

        {!added && pairing && (
          <div className="flex flex-col items-center gap-3">
            {/* A scanner needs dark modules on a light ground in any theme. */}
            <div
              className={
                expired
                  ? 'rounded-lg bg-white p-3 opacity-20'
                  : 'rounded-lg bg-white p-3'
              }
              data-testid="pairing-qr"
            >
              <QRCode value={pairing.link} size={176} />
            </div>
            <div className="text-center">
              <div className="text-muted-foreground">
                {t('account:remote.add.orType')}
              </div>
              <div
                className="font-mono text-2xl font-semibold tracking-widest text-foreground select-text"
                data-testid="pairing-code"
              >
                {pairing.code}
              </div>
              <div className="text-muted-foreground" aria-live="polite">
                {expired
                  ? t('account:remote.add.expired')
                  : t('account:remote.add.expiresIn', {
                      time: formatCountdown(left),
                    })}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          {!added && (expired || error) && (
            <Button variant="secondary" onClick={() => void create()}>
              {t('account:remote.add.newCode')}
            </Button>
          )}
          <Button onClick={() => close(false)}>
            {added
              ? t('account:remote.add.close')
              : t('account:remote.add.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
