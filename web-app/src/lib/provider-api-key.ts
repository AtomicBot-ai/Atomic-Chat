/**
 * What "the user gave us an API key" means, in one place.
 *
 * Both the provider settings page and onboarding's cloud-provider dialog write
 * keys, and they must agree: the key lives in two places at once — inside the
 * `api-key` entry of `provider.settings[]` (what the settings UI renders) and
 * on the top-level `api_key` mirror (what the chat, the onboarding gate and
 * `switchToModel` read). Writing one without the other yields a provider that
 * looks configured but cannot send a request, or vice versa.
 *
 * `duringOnboarding` is a required parameter rather than being derived here on
 * purpose: `isOnboardingPending` pulls in `provider-registry-store`, which
 * kicks off a network fetch at import time. Keeping that out of this module
 * lets onboarding components import it without dragging a fetch into their
 * import graph.
 */

import { captureProviderKeyConfigured } from '@/lib/onboarding-telemetry'
import type { ServiceHub } from '@/services'

/**
 * Copy of `settings` with the `api-key` entry's value replaced.
 *
 * Immutable down to the entry being changed — the settings page's own handler
 * mutates `controller_props` through a shallow copy, which edits the object the
 * previous state still points at. Not a bug worth chasing there, but not one to
 * reproduce here either.
 *
 * Returns the input unchanged when the provider declares no `api-key` setting.
 */
export function applyApiKeyToSettings(
  settings: ProviderSetting[],
  apiKey: string
): ProviderSetting[] {
  const index = settings.findIndex((s) => s.key === 'api-key')
  if (index === -1) return settings

  const next = [...settings]
  next[index] = {
    ...next[index],
    controller_props: { ...next[index].controller_props, value: apiKey },
  }
  return next
}

/** The full patch an API-key write means: the settings array and its mirror. */
export function buildApiKeyUpdate(
  provider: ModelProvider,
  apiKey: string
): Pick<ModelProvider, 'settings' | 'api_key'> {
  return {
    settings: applyApiKeyToSettings(provider.settings, apiKey),
    api_key: apiKey,
  }
}

/**
 * Persist an API key onto a provider.
 *
 * The zustand write is what actually stores the key (it is persisted to
 * localStorage under `model-provider`). `updateSettings` only reaches an engine
 * extension, and cloud providers have none — so it is a no-op for them, called
 * for parity with local providers and deliberately never awaited or treated as
 * the success condition.
 */
export function saveProviderApiKey(params: {
  provider: ModelProvider
  apiKey: string
  duringOnboarding: boolean
  updateProvider: (name: string, data: Partial<ModelProvider>) => void
  serviceHub: Pick<ServiceHub, 'providers'>
}): void {
  const { provider, apiKey, duringOnboarding, updateProvider, serviceHub } =
    params
  const update = buildApiKeyUpdate(provider, apiKey)

  // Only the presence of a key is reported — never the key itself.
  if (apiKey.length > 0) {
    captureProviderKeyConfigured({
      provider: provider.provider,
      duringOnboarding,
    })
  }

  updateProvider(provider.provider, { ...provider, ...update })

  try {
    void Promise.resolve(
      serviceHub.providers().updateSettings(provider.provider, update.settings)
    ).catch((error) => {
      console.warn('[provider-api-key] updateSettings failed:', error)
    })
  } catch (error) {
    console.warn('[provider-api-key] updateSettings threw:', error)
  }
}
