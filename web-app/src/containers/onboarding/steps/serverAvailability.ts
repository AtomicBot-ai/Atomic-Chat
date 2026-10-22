import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'

/**
 * Whether this build ships the local API server the purpose and server
 * steps lead to. Where it does not (web, mobile), both steps leave the flow
 * (`lib/onboarding/steps`) and the run hands off to chat past the last step.
 */
export function useLocalApiServerOffered(): boolean {
  return PlatformFeatures[PlatformFeature.LOCAL_API_SERVER]
}
