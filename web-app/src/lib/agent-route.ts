import type { AgentProviderBlockReason } from '@/lib/agent-provider'

export type MessageExecutionRoute = 'agent-ipc' | 'chat-transport'

/**
 * Why a turn landed on its engine. Attached to telemetry (`route_reason`) so
 * fallback traffic stays observable. `default-agent`, `project-thread` and
 * `rag-documents` are historical: those gates are gone (agent is opt-in now,
 * and the agent serves projects and documents natively), but the variants
 * stay so stored telemetry keeps parsing.
 */
export type RouteReason =
  | 'default-chat'
  | 'user-selected-agent'
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
  /** The user turned on Agent mode (global toggle in the composer "+" menu). */
  agentModeSelected: boolean
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
 * The single fork between the Rust agent loop and the AI-SDK chat pipeline.
 * Ordered rules, first match wins. Chat is the default; the agent engine
 * serves a turn only when the user opted in via Agent mode AND none of the
 * chat-forcing fallbacks (provider block, audio, dflash) apply.
 */
export function resolveMessageExecutionRoute(
  input: RouteInput
): ResolvedMessageExecutionRoute {
  if (input.legacyChatEngine) return { route: CHAT, reason: 'legacy-setting' }
  if (!input.agentModeSelected) return { route: CHAT, reason: 'default-chat' }
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
  return { route: 'agent-ipc', reason: 'user-selected-agent' }
}
