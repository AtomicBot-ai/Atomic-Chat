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

/** How a run ended, in `onboarding_completed.exit_path`'s vocabulary. */
export function exitPathOf({
  choice,
  jobs,
}: {
  choice: OnboardingChoice | null
  jobs: readonly OnboardingJob[]
}): OnboardingExitPath {
  if (!choice) return 'dismissed'
  if (choice.source !== 'download') return 'imported'
  return jobs.some((job) => job.kind === 'chat')
    ? 'download_started'
    : 'dismissed'
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
  const ready = findChatModel(store.choice, models.providers)

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
    const exitPath = exitPathOf({ choice: store.choice, jobs: store.jobs })
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
