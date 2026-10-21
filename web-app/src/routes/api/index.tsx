import { createFileRoute } from '@tanstack/react-router'
import { CircleHelp } from 'lucide-react'

import { route } from '@/constants/routes'
import { ServerActivityPanel } from '@/containers/server/ServerActivityPanel'
import { ServerAgents } from '@/containers/server/ServerAgents'
import { ServerButton, ServerPage } from '@/containers/server/ServerPageParts'
import { ServerSetupGuide } from '@/containers/server/ServerSetupGuide'
import { useServedModel } from '@/containers/server/useServedModel'
import { useAppState } from '@/hooks/useAppState'
import {
  useServerSetup,
  useSetupDone,
  useSetupGuideVisible,
} from '@/hooks/useServerSetup'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * Server → Overview: the setup guide on a first visit (or when asked for),
 * otherwise whether the server is ready for the user's tools; then the
 * agents and tools, and the latest activity.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.api.index as any)({
  component: ServerOverviewPage,
})

export function ServerOverviewPage() {
  const { t } = useTranslation()
  const running = useAppState((state) => state.serverStatus === 'running')
  const { engine, model } = useServedModel(running)
  const guideVisible = useSetupGuideVisible()
  const guide = useServerSetup((state) => state.guide)
  const guideRevision = useServerSetup((state) => state.guideRevision)
  const setupDone = useSetupDone()
  const openGuide = useServerSetup((state) => state.openGuide)

  return (
    <ServerPage layout="wide">
      {guideVisible ? (
        // Opened again (a card's Configure, the endpoint shortcut, Guide me),
        // it starts afresh.
        <ServerSetupGuide
          key={guideRevision}
          entry={guide ?? { path: 'choose' }}
        />
      ) : (
        <div className="sp-ready-strip">
          <div>
            <strong>
              {setupDone
                ? t('api:overview.readyTitle')
                : t('api:overview.stoppedTitle')}
            </strong>
            <p>
              {setupDone
                ? [model ?? t('api:strip.noModel'), engine]
                    .filter(Boolean)
                    .join(' · ')
                : t('api:overview.setupHint')}
            </p>
          </div>
          <ServerButton onClick={() => openGuide()}>
            <CircleHelp size={15} />
            {t('api:overview.guideMe')}
          </ServerButton>
        </div>
      )}
      <ServerAgents />
      <ServerActivityPanel />
    </ServerPage>
  )
}
