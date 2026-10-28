import { Link } from '@tanstack/react-router'
import { ArrowRight, LoaderCircle, Network, Search } from 'lucide-react'
import { useEffect, useState } from 'react'

import { route } from '@/constants/routes'
import { SERVER_AGENTS, type IntegrationAgent } from '@/constants/integrations'
import { AgentIcon } from '@/containers/AgentIcon'
import {
  pickAgentHint,
  SetupGuideHint,
  useGuideHint,
} from '@/containers/onboarding/SetupGuideHint'
import type { StatusTone } from '@/containers/api/ApiStatusIndicators'
import { useAgentActions } from '@/hooks/useAgentActions'
import { useAppState } from '@/hooks/useAppState'
import { useServerSetup } from '@/hooks/useServerSetup'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { detectIntegrationAgentsOnce } from '@/lib/integration-agent-detection'
import { isGuidedAgent } from '@/lib/integration-agent-setup'
import { useLaunchStore } from '@/stores/launch-store'

/**
 * What Atomic Chat knows about an agent: set up through it (the guide or All
 * integrations), installed on this computer, or neither. Launching a window
 * does not establish a live connection; keep reopening available at all times.
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
    if (configured.some((entry) => entry.id === agent.id)) {
      return {
        label: t('api:agents.configured'),
        tone: running ? 'ready' : 'idle',
        configured: true,
      }
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
 * Overview's "Agents & tools": every integration as a card with its one next
 * step. An agent Atomic Chat configures goes Install (when it is missing) →
 * Configure (the setup guide, which opens the agent once done) → Connect
 * (opens it again, starting the server first). Editors set up by hand go to All integrations. Then the
 * way in for the user's own application.
 */
export function ServerAgents() {
  const { t } = useTranslation()
  const openGuide = useServerSetup((state) => state.openGuide)
  const statusOf = useAgentStatus()
  const { install, connect } = useAgentActions()
  const installed = useLaunchStore((state) => state.installed)
  const phase = useLaunchStore((state) => state.phase)
  const [query, setQuery] = useState('')
  // First-run setup's "Pick your tool" points at the cards.
  const picking = useGuideHint('agents', 0)

  useEffect(() => {
    detectIntegrationAgentsOnce()
  }, [])

  const needle = query.trim().toLowerCase()
  const visible = SERVER_AGENTS.filter((agent) =>
    `${agent.name} ${agent.description}`.toLowerCase().includes(needle)
  )

  return (
    <section
      className={picking ? 'sp-agents ob-agent-pick' : 'sp-agents'}
      aria-label={t('api:agents.title')}
    >
      <SetupGuideHint path="agents" hint={0} />
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
            <article
              className={status.configured ? 'sp-tool is-connected' : 'sp-tool'}
              key={agent.id}
            >
              <div className="sp-tool-heading">
                <span className="sp-agent-icon" aria-hidden="true">
                  <AgentIcon agent={agent} />
                </span>
                <h3>{agent.name}</h3>
              </div>
              <p>{agent.description}</p>
              {!isGuidedAgent(agent) ? (
                // Set up by hand on All integrations, where no hint follows.
                <Link
                  to={route.launch.index}
                  hash={agent.id}
                  className="sp-button"
                  onClick={() => pickAgentHint('end')}
                >
                  {t('api:agents.setUp')}
                  <ArrowRight size={14} />
                </Link>
              ) : phase[agent.id] ? (
                // Installing, or All integrations' Run / this Connect.
                <button type="button" className="sp-button" disabled>
                  <span className="sp-status">
                    <LoaderCircle
                      size={14}
                      className="animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    {phase[agent.id] === 'installing'
                      ? t('api:agents.installing')
                      : t('api:agents.connecting')}
                  </span>
                </button>
              ) : agent.installable && installed[agent.id] === false ? (
                <button
                  type="button"
                  className="sp-button"
                  aria-label={t('api:agents.installAgent', {
                    name: agent.name,
                  })}
                  onClick={() => void install(agent)}
                >
                  {t('api:agents.install')}
                  <ArrowRight size={14} />
                </button>
              ) : !status.configured ? (
                <button
                  type="button"
                  className="sp-button"
                  aria-label={t('api:agents.configureAgent', {
                    name: agent.name,
                  })}
                  onClick={() => {
                    pickAgentHint('connect')
                    openGuide({ path: 'agent', agentId: agent.id })
                  }}
                >
                  {t('api:agents.configure')}
                  <ArrowRight size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  className="sp-button"
                  aria-label={t('api:agents.connectAgent', {
                    name: agent.name,
                  })}
                  onClick={() => {
                    pickAgentHint('end')
                    void connect(agent)
                  }}
                >
                  {t('api:agents.connect')}
                  <ArrowRight size={14} />
                </button>
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
