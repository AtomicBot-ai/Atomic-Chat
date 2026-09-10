import { localStorageKey } from '@/constants/localStorage'
import {
  isAnswerableModel,
  type AnswerableModelLike,
} from '@/lib/answerable-model'
import { isKnownProvider } from '@/stores/provider-registry-store'
import { isSubscriptionProvider } from '@/utils/registerRemoteProvider'

type ProviderLike = {
  provider: string
  api_key?: string
  /** `false` when the user switched the provider off; absent means on. */
  active?: boolean
  models: ReadonlyArray<AnswerableModelLike>
}

/** Providers whose models are files on this machine. */
const LOCAL_MODEL_PROVIDERS = new Set([
  'llamacpp',
  'llamacpp-upstream',
  'mlx',
  'jan',
])

/**
 * A local provider that could answer a message right now: switched on, and
 * holding at least one model that is neither a broken link nor the embedding
 * model. Counting `models.length` instead let a catalog entry, a deleted file
 * or the bundled embedder satisfy the onboarding gate — the mechanism behind
 * the 801 installs that skipped onboarding with nothing to answer with
 * (ATO-452).
 */
const hasAnswerableLocalModel = (provider: ProviderLike): boolean =>
  provider.active !== false && provider.models.some(isAnswerableModel)

/**
 * Whether the user already has at least one usable provider: a configured API
 * key, a signed-in subscription, a local provider with a loadable model, or
 * any custom provider with a loadable model. Mirrors the gate the home route
 * uses to decide whether to show onboarding. Single source of truth so the
 * startup auto-start and the route can never disagree about whether
 * onboarding is in play.
 */
export function hasValidProviders(providers: ProviderLike[]): boolean {
  return providers.some((provider) => {
    if (LOCAL_MODEL_PROVIDERS.has(provider.provider)) {
      return hasAnswerableLocalModel(provider)
    }
    if (!isKnownProvider(provider.provider)) {
      // Custom providers from the remote registry: judged by the same
      // "could this answer" rule, not by the length of the list.
      return hasAnswerableLocalModel(provider)
    }
    return Boolean(
      provider.api_key?.length ||
        // A subscription carries no key; its models are only present while it
        // is signed in, so their presence is the connected signal.
        (isSubscriptionProvider(provider.provider) && provider.models.length)
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
        provider.models.some(isAnswerableModel)
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
