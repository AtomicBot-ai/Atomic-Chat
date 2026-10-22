import { localStorageKey } from '@/constants/localStorage'
import type { StepContext } from '@/lib/onboarding/steps'

import { useCloudProviderCount } from './steps/cloudAvailability'
import { useMediaCardCount } from './steps/mediaAvailability'
import { usePermissionRowCount } from './steps/permissionsAvailability'
import { useLocalApiServerOffered } from './steps/serverAvailability'

/**
 * What decides which steps this machine shows. Each optional step reports
 * what it has to offer from its own availability hook; the backend step's
 * flag is read on every render, since it flips while the screen is up.
 */
export function useStepContext(): StepContext {
  return {
    winOrLinux: IS_WINDOWS || IS_LINUX,
    backendStepDone: Boolean(
      localStorage.getItem(localStorageKey.llamacppOnboardingDone)
    ),
    permissionRows: usePermissionRowCount(),
    cloudProviders: useCloudProviderCount(),
    mediaCards: useMediaCardCount(),
    localApiServer: useLocalApiServerOffered(),
  }
}
