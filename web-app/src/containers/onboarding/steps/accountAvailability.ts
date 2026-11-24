import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'

/**
 * Whether the run offers an Atomic Chat account. It follows the accounts
 * flag (desktop, dev builds while it is unfinished); without it the step
 * leaves the flow (`lib/onboarding/steps`).
 */
export function useAccountStepOffered(): boolean {
  return PlatformFeatures[PlatformFeature.ACCOUNTS]
}
