import { useNavigate } from '@tanstack/react-router'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { LoaderCircle, Network } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { route } from '@/constants/routes'
import {
  INTEGRATION_AGENTS,
  type IntegrationAgent,
} from '@/constants/integrations'
import { AgentIcon } from '@/containers/AgentIcon'
import { StatusDot } from '@/containers/api/ApiStatusIndicators'
import { useAgentActions } from '@/hooks/useAgentActions'
import { useAgentStatus } from '@/hooks/useAgentStatus'
import { useAppState } from '@/hooks/useAppState'
import { useServerSetup } from '@/hooks/useServerSetup'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { AgentState } from '@/lib/agent-status'
import { useLaunchStore } from '@/stores/launch-store'

import { ServerButton } from './ServerPageParts'

/**
 * Tools whose setup Atomic Chat can undo, and the command that does it.
 * Codex runs on a profile Atomic Chat owns, so disconnecting deletes it (and
 * anything an earlier release left in Codex's shared config.toml).
 */

/** A listed tool's state, as this list words it. */
const STATE_LABEL: Record<AgentState, string> = {
  not_installed: 'api:connected.notInstalled',
  installed: 'api:connected.ready',
  app_missing: 'api:connected.appMissing',
  configured: 'api:connected.ready',
  opened: 'api:connected.opened',
  connected: 'api:connected.connected',
}

/** The row Disconnect asks about: one tool, or the custom application. */
type Disconnecting = { agent: IntegrationAgent } | { endpoint: true }

/**
 * Server → Connections, "Connected tools": what was set up through Atomic
 * Chat to use this server, and where each stands: ready, opened by Atomic
 * Chat, connected once the server saw a request from it — or missing from
 * this computer (ZCode links to its download then). Connect opens a tool
 * again (starting the server first), as its card on Overview does; one
 * still running in the terminal Atomic Chat opened comes forward instead.
 * Disconnect asks first: for a tool whose config Atomic Chat writes it
 * undoes that setup (`disconnect_agent`) and the row goes only once it has;
 * an editor set up by hand only leaves the list.
 */
export function ConnectedTools() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const configured = useServerSetup((state) => state.configuredAgents)
  const endpointConfigured = useServerSetup((state) => state.endpointConfigured)
  const { openGuide, forgetAgent, forgetEndpoint } = useServerSetup.getState()
  const running = useAppState((state) => state.serverStatus === 'running')
  const phase = useLaunchStore((state) => state.phase)
  const { connect } = useAgentActions()
  const statusOf = useAgentStatus()
  const [disconnecting, setDisconnecting] = useState<Disconnecting | null>(null)

  const tools = configured.flatMap(({ id }) =>
    INTEGRATION_AGENTS.filter((agent) => agent.id === id)
  )
  const rowState = (agent: IntegrationAgent) => {
    const status = statusOf(agent)
    // Missing stays visible with the server stopped: starting it will not help.
    if (
      !running &&
      status.state !== 'app_missing' &&
      status.state !== 'not_installed'
    )
      return { ...status, label: t('api:connected.serverStopped') }
    return { ...status, label: t(STATE_LABEL[status.state]) }
  }

  const remove = async (agent: IntegrationAgent) => {
    // Every tool whose config Atomic Chat writes has its undo
    // (`disconnect_agent`); an editor set up by hand has nothing of ours.
    if (agent.configurable) {
      try {
        await invoke('disconnect_agent', { agentId: agent.id })
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

  const confirmDisconnect = () => {
    const target = disconnecting
    setDisconnecting(null)
    if (!target) return
    if ('agent' in target) void remove(target.agent)
    else forgetEndpoint()
  }

  const disconnectName =
    disconnecting && 'agent' in disconnecting
      ? disconnecting.agent.name
      : t('api:connected.endpoint')
  const undoes =
    disconnecting !== null &&
    'agent' in disconnecting &&
    disconnecting.agent.configurable

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
      {tools.map((agent) => {
        const row = rowState(agent)
        return (
          <div className="sp-connection" key={agent.id}>
            <span className="sp-agent-icon" aria-hidden="true">
              <AgentIcon agent={agent} />
            </span>
            <strong>{agent.name}</strong>
            <span className="sp-status">
              <StatusDot tone={row.tone} />
              {row.label}
            </span>
            <span className="sp-connection-actions">
              {row.state === 'app_missing' && (
                <ServerButton
                  aria-label={t('api:agents.downloadAgent', {
                    name: agent.name,
                  })}
                  onClick={() =>
                    void openUrl(agent.downloadUrl ?? agent.docsUrl)
                  }
                >
                  {t('api:agents.download')}
                </ServerButton>
              )}
              <ServerButton
                aria-label={t('api:connected.connectAgent', {
                  name: agent.name,
                })}
                disabled={phase[agent.id] !== undefined}
                onClick={() => void connect(agent)}
              >
                {phase[agent.id] && (
                  <LoaderCircle
                    size={14}
                    className="animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                )}
                {t('api:connected.connect')}
              </ServerButton>
              <ServerButton
                aria-label={
                  agent.configurable
                    ? t('api:connected.disconnect', { name: agent.name })
                    : t('api:connected.forget', { name: agent.name })
                }
                onClick={() => setDisconnecting({ agent })}
              >
                {t('api:connected.disconnectAction')}
              </ServerButton>
            </span>
          </div>
        )
      })}
      {endpointConfigured && (
        <div className="sp-connection">
          <Network size={22} aria-hidden="true" />
          <strong>{t('api:connected.endpoint')}</strong>
          <span className="sp-status">
            <StatusDot tone={running ? 'ready' : 'idle'} />
            {running
              ? t('api:connected.ready')
              : t('api:connected.serverStopped')}
          </span>
          <span className="sp-connection-actions">
            <ServerButton
              aria-label={t('api:connected.forget', {
                name: t('api:connected.endpoint'),
              })}
              onClick={() => setDisconnecting({ endpoint: true })}
            >
              {t('api:connected.disconnectAction')}
            </ServerButton>
          </span>
        </div>
      )}
      {tools.length === 0 && !endpointConfigured && (
        <p>{t('api:connected.empty')}</p>
      )}

      <Dialog
        open={disconnecting !== null}
        onOpenChange={(open) => {
          if (!open) setDisconnecting(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('api:connected.disconnectTitle', { name: disconnectName })}
            </DialogTitle>
            <DialogDescription>
              {undoes
                ? t('api:connected.disconnectHint')
                : t('api:connected.forgetHint')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDisconnecting(null)}>
              {t('api:connected.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmDisconnect}>
              {t('api:connected.disconnectAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
