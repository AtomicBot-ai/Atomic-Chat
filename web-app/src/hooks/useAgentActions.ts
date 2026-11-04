import { useCallback } from 'react'
import { toast } from 'sonner'

import type { IntegrationAgent } from '@/constants/integrations'
import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useLocalApiServerControl } from '@/hooks/useLocalApiServerControl'
import { startLocalApiServerAndSettle } from '@/hooks/useRemoteAccess'
import { useServerSetup } from '@/hooks/useServerSetup'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  AgentContextError,
  requireAgentContextWindow,
} from '@/lib/agent-context-window'
import { detectIntegrationAgent } from '@/lib/integration-agent-detection'
import {
  installIntegrationAgent,
  openIntegrationAgent,
  refuseWslOnlyAgent,
} from '@/lib/integration-agent-run'
import { writeAgentConfig } from '@/lib/integration-agent-setup'
import { useLaunchSettings } from '@/stores/launch-settings-store'
import { useLaunchStore, type RunPhase } from '@/stores/launch-store'
import { ensureServedModelRunning, servedModelId } from '@/utils/servedModel'

function setRunState(id: string, busy: boolean, phase: RunPhase) {
  const { setBusy, setPhase } = useLaunchStore.getState()
  setBusy((prev) => ({ ...prev, [id]: busy }))
  setPhase((prev) => ({ ...prev, [id]: phase }))
}

/** Ask the shell again whether `agent` is installed, with its custom path. */
function detect(agent: IntegrationAgent): Promise<boolean> {
  return detectIntegrationAgent(
    agent,
    useLaunchSettings.getState().customPaths[agent.id]
  )
}

/**
 * The actions an agent's card and its Connections row take, sharing the
 * launch store's busy state with All integrations:
 * - `install` installs the agent's binary;
 * - `connect` checks the agent is still installed (offering Install when it
 *   is not, instead of a terminal that cannot find it), starts the Local API
 *   Server when it is stopped, or loads the model a running one serves when
 *   it has none, makes sure that model's window is one the agent works in,
 *   points the agent's config at it, and opens the agent — the Run All
 *   integrations has always done.
 */
export function useAgentActions() {
  const { t } = useTranslation()
  const { start } = useLocalApiServerControl()

  const install = useCallback(
    async (agent: IntegrationAgent) => {
      if (useLaunchStore.getState().busy[agent.id]) return
      setRunState(agent.id, true, 'installing')
      try {
        await installIntegrationAgent(agent, { t, detect })
      } finally {
        setRunState(agent.id, false, undefined)
      }
    },
    [t]
  )

  const connect = useCallback(
    async (agent: IntegrationAgent) => {
      if (useLaunchStore.getState().busy[agent.id]) return
      if (refuseWslOnlyAgent(agent, t)) return
      setRunState(agent.id, true, 'connecting')
      try {
        // It may have been removed since detection ran; a terminal would only
        // say "command not found".
        if (agent.installable && !(await detect(agent))) {
          toast.error(t('api:agents.missingToast', { name: agent.name }), {
            description: t('api:agents.missingToastDesc', {
              name: agent.name,
            }),
            action: {
              label: t('api:agents.install'),
              onClick: () => void install(agent),
            },
          })
          return
        }
        // A start that fails says why in its own toast.
        const serverWasRunning =
          useAppState.getState().serverStatus === 'running'
        if (
          !serverWasRunning &&
          !(await startLocalApiServerAndSettle(start, { ensureModel: true }))
        )
          return
        const model = servedModelId()
        if (agent.requiresModel && !model) {
          toast.error(t('launch:noRunningModelToast', { name: agent.name }))
          return
        }
        // A server can run without the model it serves (a launch that could
        // not load it): the agent would get 503 for it on every request, so
        // it is loaded first, as Start loads it. Start above already did.
        if (serverWasRunning) await ensureServedModelRunning()
        // Below the agent's minimum the model is reloaded with more; when it
        // cannot be, this throws and nothing is written.
        const contextLength = await requireAgentContextWindow(agent, t)
        const server = useLocalApiServer.getState()
        await writeAgentConfig(agent, model, server, { contextLength })
        useServerSetup.getState().markAgentConfigured(agent.id)
        await openIntegrationAgent(agent, { t, model, server })
      } catch (err) {
        if (err instanceof AgentContextError) {
          toast.error(err.title, { description: err.description })
        } else {
          toast.error(t('launch:toast.configureFailed', { name: agent.name }), {
            description: err instanceof Error ? err.message : String(err),
          })
        }
      } finally {
        setRunState(agent.id, false, undefined)
      }
    },
    [install, start, t]
  )

  return { install, connect }
}
