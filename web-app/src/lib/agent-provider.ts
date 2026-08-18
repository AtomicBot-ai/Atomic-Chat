import {
  isKeylessRemoteProvider,
  isLocalProvider,
} from '@/utils/registerRemoteProvider'

/**
 * Local engines the Rust agent can reach directly.
 *
 * `llamacpp` / `llamacpp-upstream` are driven over the native `/completion`
 * endpoint (GBNF-constrained); `mlx` over its session's OpenAI-compatible
 * `/v1/chat/completions`, mirroring what `ModelFactory.createMlxModel` does for
 * regular chat. None of them need the Local API Server.
 *
 * `foundation-models` is deliberately absent: Apple's on-device runtime exposes
 * no endpoint the agent can drive.
 */
export const AGENT_LOCAL_PROVIDERS = [
  'llamacpp',
  'llamacpp-upstream',
  'mlx',
] as const

export type AgentLocalProvider = (typeof AGENT_LOCAL_PROVIDERS)[number]

/** Why Agent mode is unavailable. `null` from the helpers below means it is. */
export type AgentProviderBlockReason =
  | 'no-model'
  | 'unsupported-provider'
  | 'missing-api-key'
  | 'no-tool-support'

export function isAgentLocalProvider(
  provider: string | undefined | null
): provider is AgentLocalProvider {
  if (!provider) return false
  return (AGENT_LOCAL_PROVIDERS as readonly string[]).includes(provider)
}

/**
 * Whether Agent mode can run with this provider/model pair.
 *
 * Cloud models go through the Local API Server proxy, exactly as cloud chat
 * does. That is not checked here: `ensureRemoteProviderReady` starts the server
 * on demand before the run, so a stopped server is not a reason to grey out the
 * toggle — the backend still fails closed with `AGENT_LOCAL_SERVER_REQUIRED` if
 * the start does not take.
 *
 * Returns `null` when nothing blocks the run.
 */
export function agentProviderBlockReason(
  provider: ModelProvider | undefined | null,
  model: Model | undefined | null
): AgentProviderBlockReason | null {
  if (!provider) return 'unsupported-provider'
  if (isAgentLocalProvider(provider.provider)) {
    return model ? null : 'no-model'
  }
  // Any other local engine (today: foundation-models) has no transport.
  if (isLocalProvider(provider.provider)) return 'unsupported-provider'
  // Keyless loopback providers (Ollama, LM Studio) are out of scope for now.
  if (isKeylessRemoteProvider(provider)) return 'unsupported-provider'

  if (!model) return 'no-model'
  if (!provider.api_key?.trim()) return 'missing-api-key'
  if (!model.capabilities?.includes('tools')) return 'no-tool-support'
  return null
}

export function isAgentCapableProvider(
  provider: ModelProvider | undefined | null,
  model: Model | undefined | null
): boolean {
  return agentProviderBlockReason(provider, model) === null
}

/**
 * Context window to report to the backend.
 *
 * Only meaningful for the OpenAI-compatible transports, which have no `/props`
 * equivalent to probe. `undefined` is fine — the backend falls back to its
 * configured conversation cap.
 */
export function agentContextWindow(
  model: Model | undefined | null
): number | undefined {
  const value = model?.settings?.ctx_len?.controller_props?.value
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : undefined
}
