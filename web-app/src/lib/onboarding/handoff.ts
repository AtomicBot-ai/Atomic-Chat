import { localStorageKey } from '@/constants/localStorage'
import { route } from '@/constants/routes'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useModelProvider } from '@/hooks/useModelProvider'
import { describeProviderState } from '@/lib/onboarding'
import {
  captureOnboardingCompleted,
  captureSetupSkipped,
  type OnboardingExitPath,
} from '@/lib/onboarding-telemetry'
import { findChatModel, type OnboardingJob } from '@/lib/onboarding/jobs'
import type { OnboardingStepId } from '@/lib/onboarding/steps'
import {
  useOnboardingStore,
  type OnboardingChoice,
  type OnboardingDestination,
} from '@/stores/onboarding-store'

type NavigateTo = {
  to: string
  replace?: boolean
  search?: Record<string, unknown>
}

/** Where each handoff lands. */
export const HANDOFF_ROUTES: Record<OnboardingDestination, string> = {
  chat: route.home,
  endpoint: route.settings.local_api_server,
  agents: route.api.index,
}

/**
 * How a run ended, in `onboarding_completed.exit_path`'s vocabulary. A local
 * model outranks a cloud provider connected on the way: the run was set up
 * for it, and the provider stays connected either way.
 */
export function exitPathOf({
  choice,
  jobs,
  clouds = [],
}: {
  choice: OnboardingChoice | null
  jobs: readonly OnboardingJob[]
  /** Providers connected on the cloud step (`OnboardingState.clouds`). */
  clouds?: readonly string[]
}): OnboardingExitPath {
  if (choice && choice.source !== 'download') return 'imported'
  if (choice && jobs.some((job) => job.kind === 'chat')) {
    return 'download_started'
  }
  return clouds.length > 0 ? 'cloud_provider' : 'dismissed'
}

/**
 * The connected cloud provider a run without a local model opens the chat
 * on: the first one connected that has a model to answer with. Its first
 * model is selected, as the old setup screen did when a key was saved.
 */
export function cloudExitOf(
  clouds: readonly string[],
  providers: readonly ModelProvider[]
): { provider: string; modelId: string | null } | null {
  if (clouds.length === 0) return null
  for (const name of clouds) {
    const modelId = providers.find((provider) => provider.provider === name)
      ?.models?.[0]?.id
    if (modelId) return { provider: name, modelId }
  }
  return { provider: clouds[0], modelId: null }
}

/**
 * The one way out of the setup screen, whatever the path: Continue past the
 * last step, a purpose choice, or Skip setup.
 *
 * Setup counts as complete from here (`setup-completed`, which the update
 * banners and startup work wait for), the chat model is selected when it can
 * answer already, and `onboarding_completed` is reported — once, even when
 * the user comes back through "Back to setup" and leaves again. Downloads
 * still running carry on; `OnboardingRuntime` follows them in the app.
 */
export function handOffOnboarding({
  destination,
  stepReached,
  navigate,
  importRest,
}: {
  destination: OnboardingDestination
  stepReached: OnboardingStepId
  navigate: (to: NavigateTo) => unknown
  /** Adds the other models found on disk to the library, quietly. */
  importRest?: () => void
}): void {
  const store = useOnboardingStore.getState()
  const models = useModelProvider.getState()
  const exitPath = exitPathOf({
    choice: store.choice,
    jobs: store.jobs,
    clouds: store.clouds,
  })
  const cloud =
    exitPath === 'cloud_provider'
      ? cloudExitOf(store.clouds, models.providers)
      : null
  const local = findChatModel(store.choice, models.providers)
  // Select up front, so the picker's "first local model" fallback cannot
  // override the provider the user just connected.
  const ready =
    local ??
    (cloud?.modelId
      ? { provider: cloud.provider, modelId: cloud.modelId }
      : null)

  if (ready) {
    models.selectModelProvider(ready.provider, ready.modelId)
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({ provider: ready.provider, model: ready.modelId })
    )
  } else if (!store.choice) {
    // Leaving with nothing chosen: keep startup preload from putting the
    // first installed model in the picker behind the user's back.
    useModelLoad.getState().deferModelSelection()
    models.selectModelProvider('', '')
    localStorage.removeItem(localStorageKey.lastUsedModel)
  }

  const firstExit =
    localStorage.getItem(localStorageKey.setupCompleted) !== 'true'
  if (firstExit) {
    const providers = models.providers
    // Legacy predicate, kept verbatim so `had_any_model` stays comparable
    // with its own history: "the picker had something to show".
    const hadAnyModel = providers.some(
      (provider) => (provider.models?.length ?? 0) > 0 || !!provider.api_key
    )
    if (exitPath === 'dismissed') {
      captureSetupSkipped({ hadAnyModel, reason: 'dismissed' })
    }
    captureOnboardingCompleted({
      exitPath,
      hadAnyModel,
      providerState: describeProviderState(providers),
      // Without it a ChatGPT subscription and a pasted API key are the same
      // exit.
      exitProvider: cloud?.provider ?? null,
      stepReached,
      startedAtMs: store.startedAt,
      variant: store.variant,
      destination,
    })
    localStorage.setItem(localStorageKey.setupCompleted, 'true')
    // Same-tab signal for `useSetupCompleted`.
    window.dispatchEvent(new Event('app:setup-completed'))
  }

  importRest?.()
  useLeftPanel.getState().setLeftPanel(true)
  store.handOff(destination)

  void navigate({
    to: HANDOFF_ROUTES[destination],
    replace: true,
    search:
      destination === 'chat' && ready
        ? { threadModel: { id: ready.modelId, provider: ready.provider } }
        : {},
  })
}
