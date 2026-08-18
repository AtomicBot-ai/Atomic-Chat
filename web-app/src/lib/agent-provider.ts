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
  | 'unsupported-provider'
  | 'missing-api-key'

export function isAgentLocalProvider(
  provider: string | undefined | null
): provider is AgentLocalProvider {
  if (!provider) return false
  return (AGENT_LOCAL_PROVIDERS as readonly string[]).includes(provider)
}

/**
 * Whether Agent mode can run on this provider.
 *
 * Deliberately a *provider*-level question, not a model-level one:
 *
 *  - The `tools` capability is not required. It means "supports native OpenAI
 *    function calling", which the agent never uses — the tool contract is a
 *    text JSON array carried by the prompt (plus a JSON schema where the target
 *    accepts one). Gating on it would also block every model missing from the
 *    static `getModelCapabilities` table, including custom providers.
 *  - Whether a model is selected and loaded is checked at run time, so the
 *    sidebar toggle is not greyed out before the user has picked one.
 *  - Keyless loopback providers (Ollama, LM Studio) are allowed. They travel
 *    the same proxy path as cloud providers — `DataProvider` registers them on
 *    exactly the condition used here — and the proxy needs no upstream key for
 *    them.
 *
 * Cloud models route through the Local API Server proxy, which is started on
 * demand by `ensureRemoteProviderReady`; a stopped server is therefore not a
 * reason to block either. The backend still fails closed with
 * `AGENT_LOCAL_SERVER_REQUIRED` if the start does not take.
 *
 * Returns `null` when nothing blocks the run.
 */
export function agentProviderBlockReason(
  provider: ModelProvider | undefined | null
): AgentProviderBlockReason | null {
  if (!provider) return 'unsupported-provider'
  if (isAgentLocalProvider(provider.provider)) return null
  // Any other local engine (today: foundation-models) has no transport.
  if (isLocalProvider(provider.provider)) return 'unsupported-provider'
  // Mirrors the registration condition in `DataProvider`: a remote provider is
  // usable when it has a key, or when it is a keyless loopback server that
  // needs none. Without either the proxy cannot authenticate upstream and the
  // run is certain to fail, so it is worth blocking up front.
  if (!provider.api_key?.trim() && !isKeylessRemoteProvider(provider)) {
    return 'missing-api-key'
  }
  return null
}

export function isAgentCapableProvider(
  provider: ModelProvider | undefined | null
): boolean {
  return agentProviderBlockReason(provider) === null
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
