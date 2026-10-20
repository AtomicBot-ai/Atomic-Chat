import { Link } from '@tanstack/react-router'
import { ArrowRight, Network, Search } from 'lucide-react'
import { useEffect, useState } from 'react'

import { route } from '@/constants/routes'
import {
  INTEGRATION_AGENTS,
  type IntegrationAgent,
} from '@/constants/integrations'
import { AgentIcon } from '@/containers/AgentIcon'
import {
  StatusDot,
  type StatusTone,
} from '@/containers/api/ApiStatusIndicators'
import { useAppState } from '@/hooks/useAppState'
import { useServerSetup } from '@/hooks/useServerSetup'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { detectIntegrationAgentsOnce } from '@/lib/integration-agent-detection'
import { isGuidedAgent } from '@/lib/integration-agent-setup'
import { useLaunchStore } from '@/stores/launch-store'

import { FEATURED_AGENT_IDS } from './ServerSetupGuide'

/** Every integration, the guide's featured ones first. */
const OVERVIEW_AGENTS = [
  ...FEATURED_AGENT_IDS.flatMap((id) =>
    INTEGRATION_AGENTS.filter((agent) => agent.id === id)
  ),
  ...INTEGRATION_AGENTS.filter(
    (agent) => !FEATURED_AGENT_IDS.includes(agent.id)
  ),
]

/**
 * What Atomic Chat knows about an agent: set up through it (the guide or All
 * integrations), installed on this computer, or neither. Nothing tells it
 * whether a tool is talking to the server right now, so it never says
 * "connected".
 */
export function useAgentStatus(): (agent: IntegrationAgent) => {
  label: string
  tone: StatusTone
  configured: boolean
} {
  const { t } = useTranslation()
  const configured = useServerSetup((state) => state.configuredAgents)
  const installed = useLaunchStore((state) => state.installed)
  const running = useAppState((state) => state.serverStatus === 'running')

  return (agent) => {
    if (configured.some((entry) => entry.id === agent.id))
      return {
        label: t('api:agents.configured'),
        tone: running ? 'ready' : 'idle',
        configured: true,
      }
    return {
      label: installed[agent.id]
        ? t('api:agents.installed')
        : t('api:agents.notInstalled'),
      tone: 'idle',
      configured: false,
    }
  }
}

/**
 * Overview's "Agents & tools": every integration as a card with what Atomic
 * Chat knows about it and the one next step — the setup guide for the agents
 * it configures, All integrations for the editors set up by hand, connection
 * details once set up — then the way in for the user's own application.
 */
export function ServerAgents() {
  const { t } = useTranslation()
  const openGuide = useServerSetup((state) => state.openGuide)
  const statusOf = useAgentStatus()
  const [query, setQuery] = useState('')

  useEffect(() => {
    detectIntegrationAgentsOnce()
  }, [])

  const needle = query.trim().toLowerCase()
  const visible = OVERVIEW_AGENTS.filter((agent) =>
    `${agent.name} ${agent.description}`.toLowerCase().includes(needle)
  )

  return (
    <section className="sp-agents" aria-label={t('api:agents.title')}>
      <div className="sp-section-heading">
        <div className="min-w-0">
          <h2>{t('api:agents.title')}</h2>
          <p>{t('api:agents.subtitle')}</p>
        </div>
        <div className="sp-actions">
          <label className="sp-search">
            <Search size={15} aria-hidden="true" />
            <input
              aria-label={t('api:agents.search')}
              placeholder={t('api:agents.searchPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <Link
            to={route.launch.index}
            className="sp-button"
            data-testid="server-all-integrations"
          >
            {t('api:agents.allIntegrations')}
          </Link>
        </div>
      </div>
      <div className="sp-tools-grid">
        {visible.map((agent) => {
          const status = statusOf(agent)
          return (
            <article className="sp-tool" key={agent.id}>
              <div className="sp-row">
                <span className="sp-agent-icon" aria-hidden="true">
                  <AgentIcon agent={agent} />
                </span>
                <span className="sp-status">
                  <StatusDot tone={status.tone} />
                  {status.label}
                </span>
              </div>
              <h3>{agent.name}</h3>
              <p>{agent.description}</p>
              {status.configured ? (
                <Link to={route.api.connections} className="sp-button">
                  {t('api:agents.connectionDetails')}
                  <ArrowRight size={14} />
                </Link>
              ) : isGuidedAgent(agent) ? (
                <button
                  type="button"
                  className="sp-button"
                  aria-label={t('api:agents.configureAgent', {
                    name: agent.name,
                  })}
                  onClick={() =>
                    openGuide({ path: 'agent', agentId: agent.id })
                  }
                >
                  {t('api:agents.configure')}
                  <ArrowRight size={14} />
                </button>
              ) : (
                <Link
                  to={route.launch.index}
                  hash={agent.id}
                  className="sp-button"
                >
                  {t('api:agents.setUp')}
                  <ArrowRight size={14} />
                </Link>
              )}
            </article>
          )
        })}
      </div>
      {visible.length === 0 && (
        <p className="sp-empty">{t('api:agents.noMatch', { query })}</p>
      )}
      <button
        type="button"
        className="sp-endpoint-shortcut"
        onClick={() => openGuide({ path: 'endpoint' })}
      >
        <Network size={18} />
        <span>
          <strong>{t('api:agents.endpointTitle')}</strong>
          <small>{t('api:agents.endpointBody')}</small>
        </span>
        <ArrowRight size={17} />
      </button>
    </section>
  )
}
