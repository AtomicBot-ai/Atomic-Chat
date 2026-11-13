import { createFileRoute, redirect } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import { RemoteModelsPage } from '@/containers/account/remote/RemoteModelsPage'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.account.remote as any)({
  // Behind the dev-only accounts flag, like the rest of the section.
  beforeLoad: () => {
    if (!PlatformFeatures[PlatformFeature.ACCOUNTS]) {
      throw redirect({ to: route.home })
    }
  },
  component: AccountRemote,
})

function AccountRemote() {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <span className="font-medium text-base font-studio">
            {t('account:remote.pageTitle')}
          </span>
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-var(--page-header-height))]">
        <div className="p-4 pt-0 w-full overflow-y-auto">
          <div className="flex flex-col justify-between gap-4 gap-y-3 w-full">
            <RemoteModelsPage />
          </div>
        </div>
      </div>
    </div>
  )
}
