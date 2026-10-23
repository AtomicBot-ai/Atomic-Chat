import type { OnboardingStepId } from '@/lib/onboarding/steps'
import type { OnboardingDestination } from '@/stores/onboarding-store'

/** What the shell hands every step screen. */
export type StepProps = {
  /** Continue: the next step, or the handoff to chat past the last one. */
  next: (action?: string) => void
  /**
   * A step reached by a choice rather than Continue — the server step from
   * purpose — or back to an earlier one, such as the model from the server
   * step. Reported as leaving this step with `action`.
   */
  goTo: (step: OnboardingStepId, action?: string) => void
  /** Leave setup for the app now, by a step's own choice. */
  handOff: (destination: OnboardingDestination, action?: string) => void
}
