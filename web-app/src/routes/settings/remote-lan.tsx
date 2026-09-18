import { createFileRoute, redirect } from '@tanstack/react-router'
import { useEffect } from 'react'

import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu from '@/containers/SettingsMenu'
import { LanAccessCard } from '@/containers/remote-lan/LanAccessCard'
import { RemoteAccessCard } from '@/containers/remote-lan/RemoteAccessCard'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useLanAccess } from '@/hooks/useLanAccess'
import { useLocalApiServerControl } from '@/hooks/useLocalApiServerControl'
import { useRemoteAccess } from '@/hooks/useRemoteAccess'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.remote_lan as any)({
  // Both cards expose the Local API Server, which only desktop has. The menu
  // item is hidden elsewhere; this covers a typed or restored URL.
  beforeLoad: () => {
    if (!PlatformFeatures[PlatformFeature.LOCAL_API_SERVER]) {
      throw redirect({ to: route.settings.general })
    }
  },
  component: RemoteLanPage,
})

export function RemoteLanPage() {
  const { t } = useTranslation()
  // One control for both cards: each instance re-checks the server on focus
  // and owns a "loading model" flag, and the two cards must agree on both.
  const server = useLocalApiServerControl()
  const remote = useRemoteAccess({ server })
  const lan = useLanAccess({ server, hasApiKey: remote.hasApiKey })

  // First visit clears the "New" pill on the settings menu item.
  useEffect(() => {
    useGeneralSetting.getState().markRemoteLanBadgeSeen()
  }, [])

  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <span className="font-medium text-base font-studio">
            {t('common:settings')}
          </span>
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="p-4 pt-0 w-full overflow-y-auto">
          <div className="flex flex-col justify-between gap-4 gap-y-3 w-full">
            <RemoteAccessCard remote={remote} />
            <LanAccessCard lan={lan} />
          </div>
        </div>
      </div>
    </div>
  )
}
