import { useNavigate } from '@tanstack/react-router'
import { invoke } from '@tauri-apps/api/core'
import { Network, Unplug } from 'lucide-react'
import { toast } from 'sonner'

import { route } from '@/constants/routes'
import {
  INTEGRATION_AGENTS,
  type IntegrationAgent,
} from '@/constants/integrations'
import { AgentIcon } from '@/containers/AgentIcon'
import { StatusDot } from '@/containers/api/ApiStatusIndicators'
import { useAppState } from '@/hooks/useAppState'
import { useServerSetup } from '@/hooks/useServerSetup'
import { useTranslation } from '@/i18n/react-i18next-compat'

import { ServerButton } from './ServerPageParts'

/**
 * Tools whose setup Atomic Chat can undo, and the command that does it.
 * Codex runs on a profile Atomic Chat owns, so disconnecting deletes it (and
 * anything an earlier release left in Codex's shared config.toml).
 */
const DISCONNECT_COMMANDS: Record<string, string> = {
  codex: 'disconnect_codex',
}

/**
 * Server → Connections, "Connected tools": what was set up through Atomic
 * Chat to use this server. For a tool in `DISCONNECT_COMMANDS` the button
 * undoes that setup and the row goes only once it has; for every other tool
 * it only forgets the row — its own config stays as written.
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

  const remove = async (agent: IntegrationAgent) => {
    const command = DISCONNECT_COMMANDS[agent.id]
    if (command) {
      try {
        await invoke(command)
      } catch (err) {
        toast.error(t('api:connected.disconnectFailed', { name: agent.name }), {
          description: err instanceof Error ? err.message : String(err),
          duration: 15000,
        })
        return
      }
    }
    forgetAgent(agent.id)
  }

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
            aria-label={
              DISCONNECT_COMMANDS[agent.id]
                ? t('api:connected.disconnect', { name: agent.name })
                : t('api:connected.forget', { name: agent.name })
            }
            title={
              DISCONNECT_COMMANDS[agent.id]
                ? t('api:connected.disconnectHint')
                : t('api:connected.forgetHint')
            }
            onClick={() => void remove(agent)}
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
