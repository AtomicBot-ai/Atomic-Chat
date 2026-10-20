import { createFileRoute } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { RemoteLanSection } from '@/containers/remote-lan/RemoteLanSection'
import { ServerPage } from '@/containers/server/ServerPageParts'
import { useLocalApiServerControl } from '@/hooks/useLocalApiServerControl'
import { useTranslation } from '@/i18n/react-i18next-compat'

/** Server → Remote access: the Cloudflare tunnel and the local network. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.remote_lan as any)({
  component: RemoteAccessPage,
})

export function RemoteAccessPage() {
  const { t } = useTranslation()
  const control = useLocalApiServerControl()

  return (
    <ServerPage
      title={t('settings:remoteLan.pageTitle')}
      description={t('settings:remoteLan.pageDescription')}
    >
      <RemoteLanSection server={control} />
    </ServerPage>
  )
}
