/**
 * Which providers belong to Settings, which belong to the Cloud page, and what
 * "connected" means — in one place. Everything here is a pure predicate over
 * the provider object except the grouping, which additionally asks the
 * registry store whether an entry is one the catalogue ships.
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
  isSelfHostedProviderName,
} from '@/utils/registerRemoteProvider'
import { useProviderRegistryStore } from '@/stores/provider-registry-store'

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
export const isProviderConnected = (provider: ProviderObject): boolean => {
  // A subscription carries no key — the bearer token lives in the Rust
  // backend — so "connected" is read off the model list `useChatGptAuth`
  // writes on sign-in and empties on sign-out. Same signal `hasValidProviders`
  // already uses.
  if (isSubscriptionProvider(provider.provider))
    return (provider.models?.length ?? 0) > 0
  return Boolean(provider.api_key?.trim()) || isKeylessRemoteProvider(provider)
}

/**
 * Connected *and* with something to show for it.
 *
 * A key counts on its own — it is intent, and the section it earns in the
 * model picker is how the user gets back to the gear to fetch the catalogue.
 * Everything else has to actually offer models: a loopback server that is not
 * running is "keyless" and therefore "connected" by the rule above, and a
 * permanently empty Ollama row is noise rather than information.
 */
export const isProviderReady = (provider: ProviderObject): boolean =>
  isProviderConnected(provider) &&
  (Boolean(provider.api_key?.trim()) || (provider.models?.length ?? 0) > 0)

/**
 * Providers authorised by signing in rather than by an API key.
 *
 * They are picked from the connection dropdown like any other provider, but
 * their card on the Cloud page is a sign-in card rather than a key field — the
 * connection card renders no body for them, so there is still only one place
 * to connect one thing.
 */
const SUBSCRIPTION_PROVIDERS = new Set(['chatgpt'])

export const isSubscriptionProvider = (
  providerName: string | undefined | null
): boolean =>
  Boolean(providerName) && SUBSCRIPTION_PROVIDERS.has(providerName as string)

/** True when the provider asks for an API key at all. */
export const takesApiKey = (provider: ProviderObject): boolean =>
  provider.settings?.some((setting) => setting.key === 'api-key') === true

/**
 * A provider the user added themselves, rather than one the catalogue ships.
 *
 * Same rule the model picker, the delete dialog and onboarding already use —
 * "not in the registry" — with one guard: until the first registry load
 * resolves the catalogue is baseline-only, and calling everything else custom
 * would sweep OpenAI and friends into the self-hosted group for a frame.
 */
const isUserAddedProvider = (provider: ProviderObject): boolean => {
  const registry = useProviderRegistryStore.getState()
  if (!registry.hasInitialized) return false
  return !registry.providers.some((p) => p.provider === provider.provider)
}

export type CloudProviderGroups = {
  /** Runs on this machine or the user's own hardware: Ollama, custom endpoints. */
  selfHosted: ProviderObject[]
  /** Somebody else's servers, reached with an API key. */
  hosted: ProviderObject[]
}

/**
 * Somebody's own server rather than somebody else's service.
 *
 * Three ways to qualify, in order of how much they know:
 *
 *  - a catalogue id that is a self-hosted runtime by definition (Ollama, a
 *    `llama-server`) — true wherever it is reachable, so moving it off
 *    `localhost` onto the LAN box does not reclassify it;
 *  - a provider the user added through "Custom provider", which is their
 *    endpoint by construction — it is why the entry exists;
 *  - the property test, which catches an LM-Studio-style registry entry added
 *    later with no code change here: no key asked for, or a loopback address.
 *
 * Subscriptions declare no `api-key` setting, so the property test alone would
 * file them here. They run on somebody else's servers: excluded up front.
 */
const isSelfHostedGroup = (provider: ProviderObject): boolean => {
  if (isSubscriptionProvider(provider.provider)) return false
  return (
    isSelfHostedProviderName(provider.provider) ||
    isUserAddedProvider(provider) ||
    isKeylessRemoteProvider(provider) ||
    !takesApiKey(provider)
  )
}

/**
 * Where a subscription sits in the hosted list, 0-based: fifth, under the
 * flagships the registry ships first.
 *
 * Without this it lands last. Subscriptions live in `BASELINE_PROVIDERS`, and
 * `seedProviders` appends the baseline *after* everything the registry
 * carries — so the one connection that needs no API key would be the one the
 * user has to scroll for.
 */
const SUBSCRIPTION_HOSTED_INDEX = 4

/**
 * Lifts the subscriptions out of a hosted list and re-inserts them at
 * {@link SUBSCRIPTION_HOSTED_INDEX}, preserving the order of everything else.
 * A shorter list than that just keeps them at the end.
 */
const promoteSubscriptions = (hosted: ProviderObject[]): ProviderObject[] => {
  const subscriptions = hosted.filter((p) => isSubscriptionProvider(p.provider))
  if (subscriptions.length === 0) return hosted

  const rest = hosted.filter((p) => !isSubscriptionProvider(p.provider))
  const at = Math.min(SUBSCRIPTION_HOSTED_INDEX, rest.length)
  return [...rest.slice(0, at), ...subscriptions, ...rest.slice(at)]
}

/**
 * The connection dropdown's two groups, above and below the separator.
 *
 * Order inside each group is the caller's (the registry ships flagship-first)
 * and is otherwise deliberately not sorted — which is also what puts a
 * just-added custom provider at the end of the self-hosted list, next to the
 * "+" that made it, rather than at the bottom of the whole dropdown. The one
 * exception is the subscription promotion above.
 */
export const groupCloudProviders = (
  providers: ProviderObject[]
): CloudProviderGroups => {
  const cloud = providers.filter(isCloudProvider)
  return {
    selfHosted: cloud.filter(isSelfHostedGroup),
    hosted: promoteSubscriptions(
      cloud.filter((provider) => !isSelfHostedGroup(provider))
    ),
  }
}
