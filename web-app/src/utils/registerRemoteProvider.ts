import { invoke } from '@tauri-apps/api/core'
import { isPlatformTauri } from '@/lib/platform/utils'

type ProviderCustomHeaderPayload = {
  header: string
  value: string
}

type RegisterProviderRequest = {
  provider: string
  api_key?: string
  base_url?: string
  custom_headers: ProviderCustomHeaderPayload[]
  models: string[]
}

export const LOCAL_PROVIDER_NAMES = ['llamacpp', 'llamacpp-upstream', 'mlx', 'foundation-models'] as const
export type LocalProviderName = (typeof LOCAL_PROVIDER_NAMES)[number]

export function isLocalProvider(providerName: string | undefined | null): boolean {
  if (!providerName) return false
  return (LOCAL_PROVIDER_NAMES as readonly string[]).includes(providerName)
}

/**
 * Catalogue entries that are, by definition, a server the user runs — an
 * Ollama daemon, a `llama-server` they started themselves. They travel the
 * remote/proxy path like any cloud provider, but the machine on the other end
 * is theirs, so they belong under "Self-hosted" and may legitimately answer
 * without auth wherever they are reachable: loopback today, the box under the
 * desk or a VPS tomorrow.
 */
export const SELF_HOSTED_PROVIDER_NAMES = ['ollama', 'llamacpp-server'] as const
export type SelfHostedProviderName = (typeof SELF_HOSTED_PROVIDER_NAMES)[number]

export function isSelfHostedProviderName(
  providerName: string | undefined | null
): boolean {
  if (!providerName) return false
  return (SELF_HOSTED_PROVIDER_NAMES as readonly string[]).includes(providerName)
}

/** True when `base_url` points at a loopback address. */
export function isLoopbackUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1'
    )
  } catch {
    return false
  }
}

/**
 * OpenAI-compatible providers served over loopback (Ollama, LM Studio, …) need
 * no API key. They still travel the remote/proxy path — they are NOT local
 * engines — so the usual "no key ⇒ skip/block" gates must let them through.
 *
 * The user's own servers count wherever they are hosted, not just on loopback:
 * a `llama-server` on the LAN box or a VPS is the same unauthenticated server
 * it was on `localhost`, and a loopback-only rule would refuse to register it
 * the moment the address changed.
 */
export function isKeylessRemoteProvider(
  provider: { provider?: string; base_url?: string } | null | undefined
): boolean {
  if (!provider || isLocalProvider(provider.provider)) return false
  if (isSelfHostedProviderName(provider.provider)) return true
  return isLoopbackUrl(provider.base_url)
}

/**
 * Providers whose credential lives in the Rust backend rather than on the
 * provider object. `api_key` is empty for these by design — the proxy attaches
 * the bearer token itself — so every "no key ⇒ skip" gate must let them past.
 */
const SUBSCRIPTION_PROVIDER_NAMES = ['chatgpt'] as const

export function isSubscriptionProvider(
  providerName: string | undefined | null
): boolean {
  if (!providerName) return false
  return (SUBSCRIPTION_PROVIDER_NAMES as readonly string[]).includes(providerName)
}

/**
 * Idempotently register a remote (cloud) provider with the Tauri backend
 * so the Local API Server proxy can route requests for its models.
 *
 * Returns true when registration actually happened (provider is remote and has
 * an API key), false when it was skipped (local provider or no key), and
 * throws on backend errors.
 */
export async function registerRemoteProvider(
  provider: ModelProvider
): Promise<boolean> {
  if (isLocalProvider(provider.provider)) {
    return false
  }

  // Registration lives entirely in the Rust proxy, so without the Tauri bridge
  // there is nothing to register with. Say so once rather than letting every
  // provider raise an undefined-`invoke` TypeError into the caller's catch.
  if (!isPlatformTauri()) {
    return false
  }

  if (
    !provider.api_key &&
    !isKeylessRemoteProvider(provider) &&
    !isSubscriptionProvider(provider.provider)
  ) {
    console.log(
      `[registerRemoteProvider] Provider ${provider.provider} has no API key, skipping registration`
    )
    return false
  }

  const request: RegisterProviderRequest = {
    provider: provider.provider,
    api_key: provider.api_key || undefined,
    base_url: provider.base_url?.trim(),
    custom_headers: (provider.custom_header || []).map((h) => ({
      header: h.header,
      value: h.value,
    })),
    models: provider.models.map((e) => e.id),
  }

  await invoke('register_provider_config', { request })
  console.log(`[registerRemoteProvider] Registered remote provider: ${provider.provider}`)
  return true
}

/**
 * Unregister a previously registered remote provider. Safely swallows errors
 * because the proxy may simply not have the provider registered.
 */
export async function unregisterRemoteProvider(providerName: string): Promise<void> {
  if (isLocalProvider(providerName)) return
  try {
    await invoke('unregister_provider_config', { provider: providerName })
  } catch (error) {
    console.debug(
      `[registerRemoteProvider] Failed to unregister ${providerName} (may already be absent):`,
      error
    )
  }
}
