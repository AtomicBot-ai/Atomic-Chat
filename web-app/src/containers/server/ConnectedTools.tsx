import { useNavigate } from '@tanstack/react-router'
import { Network, Unplug } from 'lucide-react'

import { route } from '@/constants/routes'
import { INTEGRATION_AGENTS } from '@/constants/integrations'
import { AgentIcon } from '@/containers/AgentIcon'
import { StatusDot } from '@/containers/api/ApiStatusIndicators'
import { useAppState } from '@/hooks/useAppState'
import { useServerSetup } from '@/hooks/useServerSetup'
import { useTranslation } from '@/i18n/react-i18next-compat'

import { ServerButton } from './ServerPageParts'

/**
 * Server → Connections, "Connected tools": what was set up through Atomic
 * Chat to use this server. Removing a row only forgets it here — the tool's
 * own config stays as written, and nothing in Atomic Chat undoes it.
 */
export function ConnectedTools() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const configured = useServerSetup((state) => state.configuredAgents)
  const endpointConfigured = useServerSetup((state) => state.endpointConfigured)
  const { openGuide, forgetAgent, forgetEndpoint } = useServerSetup.getState()
  const running = useAppState((state) => state.serverStatus === 'running')

  const tools = configured.flatMap(({ id }) =>
    INTEGRATION_AGENTS.filter((agent) => agent.id === id)
  )
  const state = running
    ? t('api:connected.ready')
    : t('api:connected.serverStopped')

  return (
    <section className="sp-panel" aria-label={t('api:connected.title')}>
      <div className="sp-row">
        <h2>{t('api:connected.title')}</h2>
        <ServerButton
          onClick={() => {
            openGuide({ path: 'choose' })
            void navigate({ to: route.api.index })
          }}
        >
          {t('api:connected.add')}
        </ServerButton>
      </div>
      {tools.map((agent) => (
        <div className="sp-connection" key={agent.id}>
          <span className="sp-agent-icon" aria-hidden="true">
            <AgentIcon agent={agent} />
          </span>
          <strong>{agent.name}</strong>
          <span className="sp-status">
            <StatusDot tone={running ? 'ready' : 'idle'} />
            {state}
          </span>
          <ServerButton
            aria-label={t('api:connected.forget', { name: agent.name })}
            title={t('api:connected.forgetHint')}
            onClick={() => forgetAgent(agent.id)}
          >
            <Unplug size={15} />
          </ServerButton>
        </div>
      ))}
      {endpointConfigured && (
        <div className="sp-connection">
          <Network size={22} aria-hidden="true" />
          <strong>{t('api:connected.endpoint')}</strong>
          <span className="sp-status">
            <StatusDot tone={running ? 'ready' : 'idle'} />
            {state}
          </span>
          <ServerButton
            aria-label={t('api:connected.forget', {
              name: t('api:connected.endpoint'),
            })}
            title={t('api:connected.forgetHint')}
            onClick={forgetEndpoint}
          >
            <Unplug size={15} />
          </ServerButton>
        </div>
      )}
      {tools.length === 0 && !endpointConfigured && (
        <p>{t('api:connected.empty')}</p>
      )}
    </section>
  )
}
