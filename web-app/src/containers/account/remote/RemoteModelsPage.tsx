import { useEffect } from 'react'

import { Card } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { useAccountRemoteStore } from '@/stores/account-remote-store'
import { useAccountStore } from '@/stores/account-store'
import { AccountSignIn } from '../AccountSignIn'
import { OtherComputers } from './OtherComputers'
import { ShareThisComputer } from './ShareThisComputer'

/**
 * Account → Remote models: share this computer's models with the account's
 * other devices, and use the models of its other computers.
 */
export function RemoteModelsPage() {
  const { t } = useTranslation()
  const status = useAccountStore((state) => state.status)
  const hydrated = useAccountStore((state) => state.hydrated)
  const hydrate = useAccountStore((state) => state.hydrate)
  const setStatus = useAccountStore((state) => state.setStatus)
  const remoteHydrated = useAccountRemoteStore((state) => state.hydrated)
  const hydrateRemote = useAccountRemoteStore((state) => state.hydrate)

  useEffect(() => {
    void hydrate()
    void hydrateRemote()
  }, [hydrate, hydrateRemote])

  if (!hydrated) return null

  if (!status.signedIn) {
    return (
      <Card title={t('account:remote.signedOutTitle')}>
        <p className="-mt-1.5 mb-3">{t('account:remote.signedOutDesc')}</p>
        <AccountSignIn variant="rows" onSignedIn={setStatus} />
      </Card>
    )
  }

  if (!remoteHydrated) return null

  return (
    <>
      {PlatformFeatures[PlatformFeature.LOCAL_API_SERVER] && (
        <ShareThisComputer />
      )}
      <OtherComputers />
    </>
  )
}
