import type { StatusTone } from '@/containers/api/ApiStatusIndicators'
import type { IntegrationAgent } from '@/constants/integrations'
import { useAppState } from '@/hooks/useAppState'
import { useServerSetup } from '@/hooks/useServerSetup'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { deriveAgentState, isSetUp, type AgentState } from '@/lib/agent-status'
import { useLaunchStore } from '@/stores/launch-store'

export type AgentStatus = {
  state: AgentState
  /** `api:agents.*`, for the state alone. */
  label: string
  tone: StatusTone
  /** Set up and ready to open: configured, opened or connected. */
  configured: boolean
}

const LABEL_KEYS: Record<AgentState, string> = {
  not_installed: 'api:agents.notInstalled',
  installed: 'api:agents.installed',
  app_missing: 'api:agents.appMissing',
  configured: 'api:agents.configured',
  opened: 'api:agents.opened',
  connected: 'api:agents.connected',
}

function toneOf(state: AgentState, running: boolean): StatusTone {
  if (state === 'app_missing') return 'warning'
  if (!running) return 'idle'
  if (state === 'connected') return 'ready'
  // Opened, and waiting for its first request.
  if (state === 'opened') return 'pending'
  return 'idle'
}

/**
 * Where each agent stands (`deriveAgentState`): the Server's cards, its
 * sidebar palette and Connections all read it from here.
 */
export function useAgentStatus(): (agent: IntegrationAgent) => AgentStatus {
  const { t } = useTranslation()
  const configured = useServerSetup((state) => state.configuredAgents)
  const installed = useLaunchStore((state) => state.installed)
  const opened = useLaunchStore((state) => state.opened)
  const connected = useLaunchStore((state) => state.connected)
  const running = useAppState((state) => state.serverStatus === 'running')

  return (agent) => {
    const state = deriveAgentState(agent, {
      installed: installed[agent.id],
      configured: configured.some((entry) => entry.id === agent.id),
      opened: Boolean(opened[agent.id]),
      connected: Boolean(connected[agent.id]),
    })
    return {
      state,
      label: t(LABEL_KEYS[state]),
      tone: toneOf(state, running),
      configured: isSetUp(state),
    }
  }
}
