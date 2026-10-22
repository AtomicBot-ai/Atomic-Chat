import { localStorageKey } from '@/constants/localStorage'
import type { StepContext } from '@/lib/onboarding/steps'

/**
 * What decides which steps this machine shows. Read on every render: the
 * backend step's flag flips while the screen is up, and nothing else here is
 * worth subscribing to.
 *
 * Permissions, cloud, media and the server steps report nothing yet, so the
 * flow runs Welcome → (backend) → model until their screens land.
 */
export function useStepContext(): StepContext {
  return {
    winOrLinux: IS_WINDOWS || IS_LINUX,
    backendStepDone: Boolean(
      localStorage.getItem(localStorageKey.llamacppOnboardingDone)
    ),
    permissionRows: 0,
    cloudProviders: 0,
    mediaCards: 0,
    localApiServer: false,
  }
}
