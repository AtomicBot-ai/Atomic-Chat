/**
 * Which providers belong to Settings, which belong to the Cloud page, and what
 * "connected" means — in one place, as pure predicates.
 *
 * The two membership predicates are exact complements on purpose. Settings
 * renders `isLocalEngineProvider`, `/cloud` renders `isCloudProvider`, and
 * because neither can be true at the same time and neither can be false at the
 * same time, no provider can end up in no UI at all. That is not hypothetical:
 * `ollama` is a remote-transport provider on a loopback URL, so a name-only
 * "is it local" filter would strand it. It lands under Cloud → Self-hosted.
 *
 * "Connected" is derived, never persisted. `active` keeps its own meaning
 * ("enabled / show in the model picker") for local and cloud alike, and the
 * condition below is the same one `syncRemoteProviders`,
 * `ensureRemoteProviderReady` and `DropdownModelProvider` already evaluate — so
 * there is nothing new to keep in sync and nothing to migrate.
 */

import {
  isKeylessRemoteProvider,
  isLocalProvider,
} from '@/utils/registerRemoteProvider'

/**
 * A provider served by an in-process engine extension.
 *
 * Two signals, deliberately: the canonical name list, and the `persist: true`
 * flag every runtime engine carries out of `services/providers/tauri.ts` — so a
 * future engine lands in Settings without an edit here.
 *
 * `isLocalProvider` must come from `@/utils/registerRemoteProvider` (name
 * based). The same-named export in `@/lib/utils` asks `ExtensionManager` for a
 * `load` method and returns `undefined` outside a live Tauri runtime, which
 * would make every provider "cloud" under vitest.
 */
export const isLocalEngineProvider = (provider: ProviderObject): boolean =>
  isLocalProvider(provider.provider) || provider.persist === true

/** The exact complement of {@link isLocalEngineProvider}. */
export const isCloudProvider = (provider: ProviderObject): boolean =>
  !isLocalEngineProvider(provider)

/**
 * Has the user actually set this cloud provider up?
 *
 * A whitespace-only key is not a key — pasting a stray space would otherwise
 * present a provider as connected and fail on the first request.
 */
export const isProviderConnected = (provider: ProviderObject): boolean =>
  Boolean(provider.api_key?.trim()) || isKeylessRemoteProvider(provider)

/**
 * Providers authorised by signing in rather than by an API key.
 *
 * They own a dedicated card on the Cloud page — sign-in, account, model count —
 * so they are deliberately absent from the connection dropdown. Two places to
 * connect one thing is how the two drift apart.
 */
const SUBSCRIPTION_PROVIDERS = new Set(['chatgpt'])

export const isSubscriptionProvider = (
  providerName: string | undefined | null
): boolean => Boolean(providerName) && SUBSCRIPTION_PROVIDERS.has(providerName as string)

/** True when the provider asks for an API key at all. */
export const takesApiKey = (provider: ProviderObject): boolean =>
  provider.settings?.some((setting) => setting.key === 'api-key') === true

export type CloudProviderGroups = {
  /** Runs on this machine or the user's own hardware: Ollama, custom endpoints. */
  selfHosted: ProviderObject[]
  /** Somebody else's servers, reached with an API key. */
  hosted: ProviderObject[]
}

/**
 * The connection dropdown's two groups, above and below the separator.
 *
 * Membership is by property, not by id, so an LM-Studio-style entry added to
 * the registry later is grouped correctly with no code change here. Order
 * inside each group is the caller's (the registry ships flagship-first) and is
 * deliberately not sorted.
 */
export const groupCloudProviders = (
  providers: ProviderObject[]
): CloudProviderGroups => {
  const cloud = providers.filter(
    (provider) =>
      isCloudProvider(provider) && !isSubscriptionProvider(provider.provider)
  )
  return {
    selfHosted: cloud.filter(
      (provider) => isKeylessRemoteProvider(provider) || !takesApiKey(provider)
    ),
    hosted: cloud.filter(
      (provider) => !isKeylessRemoteProvider(provider) && takesApiKey(provider)
    ),
  }
}
