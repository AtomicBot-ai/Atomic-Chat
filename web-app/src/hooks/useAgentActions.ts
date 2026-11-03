import { useCallback } from 'react'
import { toast } from 'sonner'

import type { IntegrationAgent } from '@/constants/integrations'
import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useLocalApiServerControl } from '@/hooks/useLocalApiServerControl'
import { startLocalApiServerAndSettle } from '@/hooks/useRemoteAccess'
import { useServerSetup } from '@/hooks/useServerSetup'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { detectIntegrationAgent } from '@/lib/integration-agent-detection'
import {
  installIntegrationAgent,
  openIntegrationAgent,
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

/**
 * The actions an agent's card and its Connections row take, sharing the
 * launch store's busy state with All integrations:
 * - `install` installs the agent's binary;
 * - `connect` starts the Local API Server when it is stopped, or loads the
 *   model a running one serves when it has none, points the agent's config
 *   at that model, and opens the agent — the Run All integrations has always
 *   done.
 */
export function useAgentActions() {
  const { t } = useTranslation()
  const { start } = useLocalApiServerControl()

  const install = useCallback(
    async (agent: IntegrationAgent) => {
      if (useLaunchStore.getState().busy[agent.id]) return
      setRunState(agent.id, true, 'installing')
      try {
        await installIntegrationAgent(agent, {
          t,
          detect: (target) =>
            detectIntegrationAgent(
              target,
              useLaunchSettings.getState().customPaths[target.id]
            ),
        })
      } finally {
        setRunState(agent.id, false, undefined)
      }
    },
    [t]
  )

  const connect = useCallback(
    async (agent: IntegrationAgent) => {
      if (useLaunchStore.getState().busy[agent.id]) return
      setRunState(agent.id, true, 'connecting')
      try {
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
        const server = useLocalApiServer.getState()
        await writeAgentConfig(agent, model, server)
        useServerSetup.getState().markAgentConfigured(agent.id)
        await openIntegrationAgent(agent, { t, model, server })
      } catch (err) {
        toast.error(t('launch:toast.configureFailed', { name: agent.name }), {
          description: err instanceof Error ? err.message : String(err),
        })
      } finally {
        setRunState(agent.id, false, undefined)
      }
    },
    [start, t]
  )

  return { install, connect }
}
