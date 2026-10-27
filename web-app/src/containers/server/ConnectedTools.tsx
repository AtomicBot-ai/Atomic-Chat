import { useNavigate } from '@tanstack/react-router'
import { invoke } from '@tauri-apps/api/core'
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
import { useAppState } from '@/hooks/useAppState'
import { useServerSetup } from '@/hooks/useServerSetup'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useLaunchStore } from '@/stores/launch-store'

import { ServerButton } from './ServerPageParts'

/**
 * Tools whose setup Atomic Chat can undo, and the command that does it.
 * Codex runs on a profile Atomic Chat owns, so disconnecting deletes it (and
 * anything an earlier release left in Codex's shared config.toml).
 */
const DISCONNECT_COMMANDS: Record<string, string> = {
  codex: 'disconnect_codex',
}

/** The row Disconnect asks about: one tool, or the custom application. */
type Disconnecting = { agent: IntegrationAgent } | { endpoint: true }

/**
 * Server → Connections, "Connected tools": what was set up through Atomic
 * Chat to use this server. Connect opens a tool again (starting the server
 * first), as its card on Overview does. Disconnect asks first: for a tool in
 * `DISCONNECT_COMMANDS` it undoes that setup and the row goes only once it
 * has; for every other tool it only forgets the row — its own config stays
 * as written.
 */
export function ConnectedTools() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const configured = useServerSetup((state) => state.configuredAgents)
  const endpointConfigured = useServerSetup((state) => state.endpointConfigured)
  const { openGuide, forgetAgent, forgetEndpoint } = useServerSetup.getState()
  const running = useAppState((state) => state.serverStatus === 'running')
  const launched = useLaunchStore((state) => state.launched)
  const phase = useLaunchStore((state) => state.phase)
  const { connect } = useAgentActions()
  const [disconnecting, setDisconnecting] = useState<Disconnecting | null>(null)

  const tools = configured.flatMap(({ id }) =>
    INTEGRATION_AGENTS.filter((agent) => agent.id === id)
  )
  const stateOf = (agent?: IntegrationAgent) =>
    !running
      ? t('api:connected.serverStopped')
      : agent && launched[agent.id]
        ? t('api:connected.connected')
        : t('api:connected.ready')

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
    DISCONNECT_COMMANDS[disconnecting.agent.id] !== undefined

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
            {stateOf(agent)}
          </span>
          <span className="sp-connection-actions">
            <ServerButton
              aria-label={t('api:connected.connectAgent', { name: agent.name })}
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
                DISCONNECT_COMMANDS[agent.id]
                  ? t('api:connected.disconnect', { name: agent.name })
                  : t('api:connected.forget', { name: agent.name })
              }
              onClick={() => setDisconnecting({ agent })}
            >
              {t('api:connected.disconnectAction')}
            </ServerButton>
          </span>
        </div>
      ))}
      {endpointConfigured && (
        <div className="sp-connection">
          <Network size={22} aria-hidden="true" />
          <strong>{t('api:connected.endpoint')}</strong>
          <span className="sp-status">
            <StatusDot tone={running ? 'ready' : 'idle'} />
            {stateOf()}
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
