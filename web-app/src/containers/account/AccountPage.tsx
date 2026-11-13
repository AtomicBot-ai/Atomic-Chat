import { useEffect, useState } from 'react'

import { Card, CardItem } from '@/containers/Card'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { accountErrorMessage } from '@/lib/account'
import { useAccountStore } from '@/stores/account-store'
import { toAccountError } from '@/services/account/errors'
import type { AccountError } from '@/services/account/types'
import { AccountDevices } from './AccountDevices'
import { AccountProfile } from './AccountProfile'
import { AccountSignIn } from './AccountSignIn'
import { DeleteAccountDialog } from './DeleteAccountDialog'

// The session is gone; the `account-changed` event flips the page by itself.
const SIGNED_OUT_CODES = new Set([
  'invalid_grant',
  'invalid_token',
  'not_signed_in',
])

/**
 * Settings → Account: the sign-in form while signed out; profile, devices
 * and account deletion once signed in.
 */
export function AccountPage() {
  const { t } = useTranslation()
  const account = useServiceHub().account()
  const status = useAccountStore((state) => state.status)
  const hydrated = useAccountStore((state) => state.hydrated)
  const hydrate = useAccountStore((state) => state.hydrate)
  const setStatus = useAccountStore((state) => state.setStatus)
  const setUser = useAccountStore((state) => state.setUser)

  const [profileError, setProfileError] = useState<AccountError | null>(null)

  const user = status.signedIn ? status.user : null
  const userId = user?.id

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // Fresh from the backend each time the page opens for an account.
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    setProfileError(null)
    account
      .profile()
      .then((next) => {
        if (cancelled) return
        setUser(next.user)
      })
      .catch((raw) => {
        if (cancelled) return
        const accountError = toAccountError(raw)
        if (!SIGNED_OUT_CODES.has(accountError.code))
          setProfileError(accountError)
      })
    return () => {
      cancelled = true
    }
  }, [account, userId, setUser])

  if (!hydrated) return null

  if (!user) {
    return (
      <Card title={t('common:navigation.account')}>
        <AccountSignIn variant="rows" onSignedIn={setStatus} />
      </Card>
    )
  }

  return (
    <>
      <AccountProfile
        user={user}
        profileError={
          profileError ? accountErrorMessage(t, profileError) : null
        }
        onProfileUpdated={(next) => setUser(next.user)}
      />
      <AccountDevices />
      <Card title={t('account:danger.title')}>
        <CardItem
          title={t('account:danger.deleteTitle')}
          description={t('account:danger.deleteDesc')}
          actions={<DeleteAccountDialog user={user} />}
        />
      </Card>
    </>
  )
}
