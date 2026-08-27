import type { AgentProviderBlockReason } from '@/lib/agent-provider'

export type MessageExecutionRoute = 'agent-ipc' | 'chat-transport'

/**
 * Why a turn landed on its engine. Attached to telemetry (`route_reason`) so
 * fallback traffic stays observable while the legacy chat pipeline is being
 * retired.
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

/**
 * Capability gates for the unified agent engine. Flipped to `true` once the
 * Rust loop gains native RAG tools / project support; until then those threads
 * keep the chat transport, which serves them exactly as before the merge.
 */
export const AGENT_SUPPORTS_RAG = false
export const AGENT_SUPPORTS_PROJECTS = false

export type RouteInput = {
  /** Settings → General escape hatch: force every turn onto the old pipeline. */
  legacyChatEngine: boolean
  /** From `agentProviderBlockReason(provider)`; `null` = agent-capable. */
  providerBlockReason: AgentProviderBlockReason | null
  /** This turn carries an audio attachment (agent loop cannot take audio). */
  hasAudioAttachment: boolean
  /** llamacpp-upstream dflash mode (`shouldSuppressToolsForUpstreamDflash`). */
  dflashEnabled: boolean
  /** Thread belongs to a project (`thread.metadata.project?.id`). */
  isProjectThread: boolean
  /** Thread or its project has vector-indexed documents. */
  threadHasRagDocs: boolean
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
  if (input.isProjectThread && !AGENT_SUPPORTS_PROJECTS) {
    return { route: CHAT, reason: 'project-thread' }
  }
  if (input.threadHasRagDocs && !AGENT_SUPPORTS_RAG) {
    return { route: CHAT, reason: 'rag-documents' }
  }
  return { route: 'agent-ipc', reason: 'default-agent' }
}
