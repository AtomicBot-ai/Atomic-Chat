/**
 * The first-run flow as data: which steps a variant shows, in which order, and
 * which of them depend on the machine. Components never hard-code "what comes
 * next" — they ask `nextStep`/`prevStep` — so a shorter variant is one more
 * entry in `ONBOARDING_STEPS`, not a rewrite of the screens.
 */

export type OnboardingStepId =
  | 'welcome'
  | 'backend'
  | 'model'
  | 'permissions'
  | 'cloud'
  | 'media'
  | 'purpose'
  | 'server'

/** Only the full flow exists today; the onboarding experiment adds the rest. */
export type OnboardingVariant = 'full'

/** What the machine and the build offer, for the steps that depend on it. */
export type StepContext = {
  /** Windows or Linux: the llama.cpp GPU backend is picked on first run. */
  winOrLinux: boolean
  /** That backend step already ran (`llama_cpp_onboarding_done`). */
  backendStepDone: boolean
  /** Permissions this platform can actually ask for. */
  permissionRows: number
  cloudProviders: number
  /** Image/video models this machine can run. */
  mediaCards: number
  /** The build ships the local API server. */
  localApiServer: boolean
}

export type StepDef = {
  id: OnboardingStepId
  /** Counted in "STEP 0N / 0M"; an uncounted step shows no counter. */
  counted: boolean
  /**
   * Reached only from this step's choice, never by Continue. It shares its
   * parent's counter and goes back to it.
   */
  branchOf?: OnboardingStepId
  include?: (context: StepContext) => boolean
}

export const ONBOARDING_STEPS: Record<OnboardingVariant, readonly StepDef[]> = {
  full: [
    { id: 'welcome', counted: true },
    {
      id: 'backend',
      counted: false,
      include: (context) => context.winOrLinux && !context.backendStepDone,
    },
    { id: 'model', counted: true },
    {
      id: 'permissions',
      counted: true,
      include: (context) => context.permissionRows > 0,
    },
    {
      id: 'cloud',
      counted: true,
      include: (context) => context.cloudProviders > 0,
    },
    {
      id: 'media',
      counted: true,
      include: (context) => context.mediaCards > 0,
    },
    {
      id: 'purpose',
      counted: true,
      include: (context) => context.localApiServer,
    },
    {
      id: 'server',
      counted: false,
      branchOf: 'purpose',
      include: (context) => context.localApiServer,
    },
  ],
}

/** The variant this install runs. The onboarding experiment replaces this. */
export function getOnboardingVariant(): OnboardingVariant {
  return 'full'
}

/** The steps this machine shows, in order. Empty means no onboarding at all. */
export function resolveSteps(
  variant: OnboardingVariant,
  context: StepContext
): StepDef[] {
  return ONBOARDING_STEPS[variant].filter(
    (step) => !step.include || step.include(context)
  )
}

/** The step Continue leads to; `null` past the last one, which hands off. */
export function nextStep(
  steps: readonly StepDef[],
  current: OnboardingStepId
): OnboardingStepId | null {
  const linear = steps.filter((step) => !step.branchOf)
  const index = linear.findIndex((step) => step.id === current)
  if (index < 0) return null
  return linear[index + 1]?.id ?? null
}

/** The step Back leads to; `null` on the first one. */
export function prevStep(
  steps: readonly StepDef[],
  current: OnboardingStepId
): OnboardingStepId | null {
  const step = steps.find((candidate) => candidate.id === current)
  if (!step) return null
  if (step.branchOf) return step.branchOf
  const linear = steps.filter((candidate) => !candidate.branchOf)
  const index = linear.findIndex((candidate) => candidate.id === current)
  return index > 0 ? linear[index - 1].id : null
}

/**
 * "STEP 0N / 0M" for a step: its place among the counted steps. A branch shows
 * its parent's place; any other uncounted step shows nothing.
 */
export function progressOf(
  steps: readonly StepDef[],
  current: OnboardingStepId
): { index: number; count: number } | null {
  const step = steps.find((candidate) => candidate.id === current)
  if (!step) return null
  const counted = steps.filter((candidate) => candidate.counted)
  const anchor = step.branchOf ?? (step.counted ? step.id : null)
  if (!anchor) return null
  const index = counted.findIndex((candidate) => candidate.id === anchor)
  return index < 0 ? null : { index: index + 1, count: counted.length }
}

/**
 * Where a saved run resumes. A step that no longer applies — the backend step
 * after its relaunch, the media step on a build without it — gives way to the
 * next one that does, so a relaunch never lands on a screen that is gone.
 */
export function normalizeStep(
  variant: OnboardingVariant,
  steps: readonly StepDef[],
  saved: OnboardingStepId | null | undefined
): OnboardingStepId | null {
  if (steps.length === 0) return null
  if (!saved) return steps[0].id
  if (steps.some((step) => step.id === saved)) return saved
  const order = ONBOARDING_STEPS[variant]
  const from = order.findIndex((step) => step.id === saved)
  if (from < 0) return steps[0].id
  const shown = new Set(steps.map((step) => step.id))
  const next = order
    .slice(from + 1)
    .find((step) => !step.branchOf && shown.has(step.id))
  const linear = steps.filter((step) => !step.branchOf)
  return next?.id ?? linear[linear.length - 1]?.id ?? steps[0].id
}
