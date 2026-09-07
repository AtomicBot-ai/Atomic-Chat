import { localStorageKey } from '@/constants/localStorage'
import { isKnownProvider } from '@/stores/provider-registry-store'
import { isSubscriptionProvider } from '@/utils/registerRemoteProvider'

type ProviderLike = {
  provider: string
  api_key?: string
  models: unknown[]
}

/**
 * Providers whose models are files on this machine. `mlx` is here even though
 * `hasValidProviders` does not list it: that gate predates the MLX engine and
 * MLX models still occupy disk exactly like llama.cpp ones.
 */
const LOCAL_MODEL_PROVIDERS = new Set([
  'llamacpp',
  'llamacpp-upstream',
  'mlx',
  'jan',
])

/**
 * Whether the user already has at least one usable provider: a configured API
 * key, or a local llama.cpp / Jan provider with models, or any custom provider
 * with models. Mirrors the gate the home route uses to decide whether to show
 * onboarding. Single source of truth so the startup auto-start and the route
 * can never disagree about whether onboarding is in play.
 */
export function hasValidProviders(providers: ProviderLike[]): boolean {
  return providers.some((provider) => {
    if (!isKnownProvider(provider.provider)) {
      return provider.models.length > 0
    }
    return Boolean(
      provider.api_key?.length ||
        // A subscription carries no key; its models are only present while it
        // is signed in, so their presence is the connected signal.
        (isSubscriptionProvider(provider.provider) && provider.models.length) ||
        (provider.provider === 'llamacpp' && provider.models.length) ||
        (provider.provider === 'llamacpp-upstream' && provider.models.length) ||
        (provider.provider === 'jan' && provider.models.length)
    )
  })
}

/**
 * What the user actually had when they left onboarding.
 *
 * `onboarding_completed.had_any_model` never answered this. Three of its four
 * call sites hardcode `true`, and the fourth computes
 * `models.length > 0 || !!api_key` — "the picker had something to show", which
 * is true for almost every install, including ones that leave with nothing on
 * disk. Splitting it means "does a model exist locally" and "is a cloud
 * provider configured" can finally be asked separately.
 *
 * `gateValidProviders` is deliberately the gate's own predicate rather than a
 * third opinion: the two have always been able to disagree about whether
 * onboarding is in play, and shipping both makes that disagreement visible as
 * `had_any_model != gate_valid_providers` instead of a suspicion.
 */
export function describeProviderState(providers: ProviderLike[]): {
  hadLocalModelOnDisk: boolean
  hadCloudKey: boolean
  gateValidProviders: boolean
} {
  return {
    hadLocalModelOnDisk: providers.some(
      (provider) =>
        LOCAL_MODEL_PROVIDERS.has(provider.provider) &&
        provider.models.length > 0
    ),
    hadCloudKey: providers.some(
      (provider) =>
        !LOCAL_MODEL_PROVIDERS.has(provider.provider) &&
        Boolean(provider.api_key?.length)
    ),
    gateValidProviders: hasValidProviders(providers),
  }
}

function isSetupCompleted(): boolean {
  return (
    typeof window !== 'undefined' &&
    localStorage.getItem(localStorageKey.setupCompleted) === 'true'
  )
}

/**
 * Whether the onboarding screen will be shown for this launch. Deterministic
 * (derived from providers + the persisted `setupCompleted` flag), so it does
 * NOT depend on whether SetupScreen has mounted yet — unlike a runtime flag,
 * which races against DataProvider's own startup effect.
 *
 * `FORCE_ONBOARDING` decides whether onboarding is *entered* despite installed
 * models; it deliberately does not decide whether it can be *left*, or the
 * auto-exit, the chat handoff and the model reminder would be unreachable in
 * the one build made for exercising them. `resetForcedOnboardingRun()` clears
 * the completion flag once per launch so the forced run still repeats.
 */
export function isOnboardingPending(providers: ProviderLike[]): boolean {
  if (isSetupCompleted()) return false
  if (typeof FORCE_ONBOARDING !== 'undefined' && FORCE_ONBOARDING) return true
  return !hasValidProviders(providers)
}

/**
 * Dev-only, must run before React mounts: drops the persisted completion flag
 * so a `FORCE_ONBOARDING` build replays the whole flow on every launch without
 * a factory reset. No-op in every shipped build.
 */
export function resetForcedOnboardingRun(): void {
  if (typeof FORCE_ONBOARDING === 'undefined' || !FORCE_ONBOARDING) return
  if (typeof window === 'undefined') return
  localStorage.removeItem(localStorageKey.setupCompleted)
}
