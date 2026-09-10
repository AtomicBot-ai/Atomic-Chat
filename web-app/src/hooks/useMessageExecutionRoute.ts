import { useAgentProvider } from '@/hooks/useAgentProvider'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { agentProviderBlockReason } from '@/lib/agent-provider'
import {
  resolveMessageExecutionRoute,
  type ResolvedMessageExecutionRoute,
} from '@/lib/agent-route'
import { shouldSuppressToolsForUpstreamDflash } from '@/lib/custom-chat-transport'

/**
 * Render-time view of the engine fork: which pipeline would serve a turn sent
 * right now. Covers the thread-stable routing inputs only — per-turn factors
 * (an audio attachment) are resolved again at send time, so agent-only UI
 * gated on this hook can still fall back for individual turns.
 */
export function useMessageExecutionRoute(): ResolvedMessageExecutionRoute {
  const legacyChatEngine = useGeneralSetting((s) => s.legacyChatEngine)
  const agentModeSelected = useGeneralSetting((s) => s.agentModeEnabled)
  const provider = useAgentProvider()

  return resolveMessageExecutionRoute({
    legacyChatEngine,
    agentModeSelected,
    providerBlockReason: agentProviderBlockReason(provider),
    hasAudioAttachment: false,
    dflashEnabled: shouldSuppressToolsForUpstreamDflash(
      provider?.provider ?? '',
      provider?.settings
    ),
  })
}
