import { createFileRoute } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { ServerConfiguration } from '@/containers/server/ServerConfiguration'
import { ServerPage } from '@/containers/server/ServerPageParts'
import { useTranslation } from '@/i18n/react-i18next-compat'

/** Server → Configuration: host, port, prefix, key, autostart, advanced. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.local_api_server as any)({
  component: ServerConfigurationPage,
})

export function ServerConfigurationPage() {
  const { t } = useTranslation()

  return (
    <ServerPage title={t('settings:serverConfig.title')}>
      <ServerConfiguration />
    </ServerPage>
  )
}
