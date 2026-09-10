import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { agentProviderBlockReason } from '@/lib/agent-provider'
import {
  resolveMessageExecutionRoute,
  type ResolvedMessageExecutionRoute,
} from '@/lib/agent-route'
import { shouldSuppressToolsForUpstreamDflash } from '@/lib/custom-chat-transport'

type TurnFactors = {
  /** This turn attaches audio (agent loop cannot take audio). */
  hasAudioAttachment?: boolean
}

/**
 * Send-time engine resolution: reads the routing inputs imperatively from the
 * stores so callbacks don't have to subscribe to them. The render-time
 * counterpart is `useMessageExecutionRoute`.
 */
export function resolveThreadExecutionRoute(
  _threadId: string,
  turn: TurnFactors = {}
): ResolvedMessageExecutionRoute {
  const providerState = useModelProvider.getState()
  const provider = providerState.getProviderByName(providerState.selectedProvider)

  return resolveMessageExecutionRoute({
    legacyChatEngine: useGeneralSetting.getState().legacyChatEngine,
    agentModeSelected: useGeneralSetting.getState().agentModeEnabled,
    providerBlockReason: agentProviderBlockReason(provider),
    hasAudioAttachment: Boolean(turn.hasAudioAttachment),
    dflashEnabled: shouldSuppressToolsForUpstreamDflash(
      provider?.provider ?? '',
      provider?.settings
    ),
  })
}
