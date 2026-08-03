import { localStorageKey } from '@/constants/localStorage'
import { isKnownProvider } from '@/stores/provider-registry-store'

type ProviderLike = {
  provider: string
  api_key?: string
  models: unknown[]
}

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
        (provider.provider === 'llamacpp' && provider.models.length) ||
        (provider.provider === 'llamacpp-upstream' && provider.models.length) ||
        (provider.provider === 'jan' && provider.models.length)
    )
  })
}

/**
 * Whether the onboarding screen will be shown for this launch. Deterministic
 * (derived from providers + the persisted `setupCompleted` flag), so it does
 * NOT depend on whether SetupScreen has mounted yet — unlike a runtime flag,
 * which races against DataProvider's own startup effect.
 */
export function isOnboardingPending(providers: ProviderLike[]): boolean {
  if (typeof FORCE_ONBOARDING !== 'undefined' && FORCE_ONBOARDING) return true
  const setupCompleted =
    typeof window !== 'undefined' &&
    localStorage.getItem(localStorageKey.setupCompleted) === 'true'
  return !hasValidProviders(providers) && !setupCompleted
}
