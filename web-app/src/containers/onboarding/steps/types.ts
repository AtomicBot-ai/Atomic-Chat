import type { OnboardingDestination } from '@/stores/onboarding-store'

/** What the shell hands every step screen. */
export type StepProps = {
  /** Continue: the next step, or the handoff to chat past the last one. */
  next: (action?: string) => void
  /** Leave setup for the app now, by a step's own choice. */
  handOff: (destination: OnboardingDestination, action?: string) => void
}
