import { invoke } from '@tauri-apps/api/core'

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
 */
export function isKeylessRemoteProvider(
  provider: { provider?: string; base_url?: string } | null | undefined
): boolean {
  if (!provider || isLocalProvider(provider.provider)) return false
  return isLoopbackUrl(provider.base_url)
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

  if (!provider.api_key && !isKeylessRemoteProvider(provider)) {
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
