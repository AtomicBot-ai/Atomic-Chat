import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

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
import { accountErrorMessage } from '@/lib/account'
import { useAccountStore } from '@/stores/account-store'
import { toAccountError } from '@/services/account/errors'
import type { AccountStatus, AccountUser } from '@/services/account/types'
import { AccountSignIn } from './AccountSignIn'

type Step = 'confirm' | 'reauth'

/**
 * Deleting the account, behind a confirmation. A sign-in older than the
 * backend allows (`reauth_required`) turns the dialog into "Confirm it's you";
 * the delete is retried only if that sign-in is the same account.
 */
export function DeleteAccountDialog({ user }: { user: AccountUser }) {
  const { t } = useTranslation()
  const account = useServiceHub().account()
  const setStatus = useAccountStore((state) => state.setStatus)

  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('confirm')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The account the user asked to delete, fixed when they confirmed.
  const target = useRef<{ id: string; email: string } | null>(null)

  const reset = () => {
    setStep('confirm')
    setDeleting(false)
    setError(null)
    target.current = null
  }

  const changeOpen = (next: boolean) => {
    if (deleting) return
    setOpen(next)
    if (!next) reset()
  }

  const remove = async () => {
    setDeleting(true)
    setError(null)
    try {
      const status = await account.deleteAccount()
      setOpen(false)
      reset()
      setStatus(status)
      toast.success(t('account:delete.deleted'))
    } catch (raw) {
      const accountError = toAccountError(raw)
      setDeleting(false)
      if (accountError.code === 'reauth_required') {
        setStep('reauth')
        return
      }
      setError(accountErrorMessage(t, accountError))
    }
  }

  const confirm = () => {
    target.current = { id: user.id, email: user.email }
    void remove()
  }

  const reauthenticated = (status: AccountStatus) => {
    if (!target.current || status.user?.id !== target.current.id) {
      // Someone else signed in: that account is not the one to delete.
      setError(t('account:delete.differentAccount'))
      return
    }
    void remove()
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="account-delete"
      >
        {t('account:danger.delete')}
      </Button>
      <DialogContent showCloseButton={!deleting}>
        {step === 'confirm' ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('account:delete.title')}</DialogTitle>
              <DialogDescription>
                {t('account:delete.description')}
              </DialogDescription>
            </DialogHeader>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                variant="ghost"
                size="sm"
                disabled={deleting}
                onClick={() => changeOpen(false)}
              >
                {t('account:delete.cancel')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={deleting}
                onClick={confirm}
              >
                {deleting && <Loader2 className="animate-spin" />}
                {t('account:delete.confirm')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('account:delete.reauthTitle')}</DialogTitle>
              <DialogDescription>
                {t('account:delete.reauthDescription', {
                  email: target.current?.email ?? user.email,
                })}
              </DialogDescription>
            </DialogHeader>
            {deleting ? (
              <div
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
              >
                <Loader2 className="size-4 animate-spin" />
                {t('account:delete.deleting')}
              </div>
            ) : (
              <AccountSignIn
                lockedEmail={target.current?.email ?? user.email}
                onSignedIn={reauthenticated}
                className="max-w-none"
              />
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
