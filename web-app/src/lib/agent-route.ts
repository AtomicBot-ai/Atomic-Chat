import type { AgentProviderBlockReason } from '@/lib/agent-provider'

export type MessageExecutionRoute = 'agent-ipc' | 'chat-transport'

/**
 * Why a turn landed on its engine. Attached to telemetry (`route_reason`) so
 * fallback traffic stays observable while the legacy chat pipeline is being
 * retired. `project-thread` and `rag-documents` are historical: those gates
 * are gone (the agent serves projects and documents natively), but the
 * variants stay so stored telemetry keeps parsing.
 */
export type RouteReason =
  | 'default-agent'
  | 'legacy-setting'
  | 'provider-unsupported'
  | 'missing-api-key'
  | 'audio-attachment'
  | 'dflash'
  | 'project-thread'
  | 'rag-documents'

export type RouteInput = {
  /** Settings → General escape hatch: force every turn onto the old pipeline. */
  legacyChatEngine: boolean
  /** From `agentProviderBlockReason(provider)`; `null` = agent-capable. */
  providerBlockReason: AgentProviderBlockReason | null
  /** This turn carries an audio attachment (agent loop cannot take audio). */
  hasAudioAttachment: boolean
  /** llamacpp-upstream dflash mode (`shouldSuppressToolsForUpstreamDflash`). */
  dflashEnabled: boolean
}

export type ResolvedMessageExecutionRoute = {
  route: MessageExecutionRoute
  reason: RouteReason
}

const CHAT: MessageExecutionRoute = 'chat-transport'

/**
 * The single fork between the Rust agent loop and the legacy AI-SDK chat
 * pipeline. Ordered rules, first match wins; everything not explicitly sent
 * to the chat transport runs on the agent engine.
 */
export function resolveMessageExecutionRoute(
  input: RouteInput
): ResolvedMessageExecutionRoute {
  if (input.legacyChatEngine) return { route: CHAT, reason: 'legacy-setting' }
  if (input.providerBlockReason === 'unsupported-provider') {
    return { route: CHAT, reason: 'provider-unsupported' }
  }
  if (input.providerBlockReason === 'missing-api-key') {
    return { route: CHAT, reason: 'missing-api-key' }
  }
  if (input.hasAudioAttachment) {
    return { route: CHAT, reason: 'audio-attachment' }
  }
  if (input.dflashEnabled) return { route: CHAT, reason: 'dflash' }
  return { route: 'agent-ipc', reason: 'default-agent' }
}
