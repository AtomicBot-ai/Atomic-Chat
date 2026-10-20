import { createFileRoute } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { ConnectionDetails } from '@/containers/server/ConnectionDetails'
import { ServerPage } from '@/containers/server/ServerPageParts'
import { TryRequest } from '@/containers/server/TryRequest'
import { useTranslation } from '@/i18n/react-i18next-compat'

/** Server → Connections: the address and facts a client needs, and a test. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.api.connections as any)({
  component: ServerConnectionsPage,
})

export function ServerConnectionsPage() {
  const { t } = useTranslation()

  return (
    <ServerPage title={t('api:connections.title')}>
      <ConnectionDetails />
      <TryRequest />
    </ServerPage>
  )
}
