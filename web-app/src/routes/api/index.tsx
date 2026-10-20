import { createFileRoute, Link } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { ServerActivityPanel } from '@/containers/server/ServerActivityPanel'
import { ServerPage } from '@/containers/server/ServerPageParts'
import { useServedModel } from '@/containers/server/useServedModel'
import { useAppState } from '@/hooks/useAppState'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * Server → Overview: whether the server is ready for the user's tools and
 * what it serves, then its latest activity. The agents and the setup guide
 * join it next.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.api.index as any)({
  component: ServerOverviewPage,
})

export function ServerOverviewPage() {
  const { t } = useTranslation()
  const running = useAppState((state) => state.serverStatus === 'running')
  const { engine, model } = useServedModel(running)

  return (
    <ServerPage>
      <div className="sp-ready-strip">
        <div>
          <strong>
            {running
              ? t('api:overview.readyTitle')
              : t('api:overview.stoppedTitle')}
          </strong>
          <p>
            {running
              ? [model ?? t('api:strip.noModel'), engine]
                  .filter(Boolean)
                  .join(' · ')
              : t('api:overview.stoppedHint')}
          </p>
        </div>
        <Link to={route.api.connections} className="sp-button">
          {t('api:overview.connectionDetails')}
        </Link>
      </div>
      <ServerActivityPanel />
    </ServerPage>
  )
}
