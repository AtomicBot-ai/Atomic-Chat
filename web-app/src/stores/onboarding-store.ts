import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { localStorageKey } from '@/constants/localStorage'
import type { OnboardingJob, OnboardingJobPhase } from '@/lib/onboarding/jobs'
import type {
  OnboardingStepId,
  OnboardingVariant,
} from '@/lib/onboarding/steps'

/**
 * Where a first run stands:
 * - `active`: the setup screen is the user's place, including after a relaunch;
 * - `handedOff`: they are in the app while its downloads finish, with a way
 *   back to setup;
 * - `finished`: nothing of the run is left on screen.
 */
export type OnboardingPhase = 'idle' | 'active' | 'handedOff' | 'finished'

export type OnboardingDestination = 'chat' | 'endpoint' | 'agents'

/** How the chat model was found: offered, in the library, on disk, built in. */
export type OnboardingChoiceSource = 'download' | 'library' | 'scan' | 'builtin'

export type OnboardingChoice = {
  source: OnboardingChoiceSource
  /** The provider the model answers from once it is ready. */
  provider: string
  /** What the row was picked by: a catalog quant, a library id or a file path. */
  modelId: string
  title: string
  /** The provider model ids it can register under (`lib/onboarding/jobs`). */
  matchIds: string[]
}

export type OnboardingPermissionResult = 'granted' | 'denied'

/** The hints a server handoff shows on the real Server pages. */
export type OnboardingGuide = { path: 'endpoint' | 'agents'; hint: number }

type OnboardingData = {
  variant: OnboardingVariant
  phase: OnboardingPhase
  step: OnboardingStepId | null
  startedAt: number | null
  choice: OnboardingChoice | null
  jobs: OnboardingJob[]
  permissions: Partial<Record<string, OnboardingPermissionResult>>
  destination: OnboardingDestination | null
  guide: OnboardingGuide | null
  /** The download panel shown after the handoff was closed. */
  panelDismissed: boolean
}

type OnboardingState = OnboardingData & {
  /** Starts a run; a run already under way resumes instead. */
  begin: (variant: OnboardingVariant, step: OnboardingStepId) => void
  goTo: (step: OnboardingStepId) => void
  choose: (choice: OnboardingChoice | null) => void
  /** Adds a job, or replaces the one with the same key. */
  enqueue: (job: OnboardingJob) => void
  dequeue: (key: string) => void
  setJobPhase: (key: string, phase: OnboardingJobPhase) => void
  setPermission: (id: string, result: OnboardingPermissionResult) => void
  handOff: (destination: OnboardingDestination) => void
  /** "Back to setup" after a handoff. */
  reopen: () => void
  setGuide: (guide: OnboardingGuide | null) => void
  dismissPanel: () => void
  finish: () => void
  reset: () => void
}

const initialData: OnboardingData = {
  variant: 'full',
  phase: 'idle',
  step: null,
  startedAt: null,
  choice: null,
  jobs: [],
  permissions: {},
  destination: null,
  guide: null,
  panelDismissed: false,
}

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set) => ({
      ...initialData,
      begin: (variant, step) =>
        set((state) =>
          state.phase === 'idle'
            ? { variant, phase: 'active', step, startedAt: Date.now() }
            : state
        ),
      goTo: (step) => set({ step }),
      choose: (choice) => set({ choice }),
      enqueue: (job) =>
        set((state) => {
          const index = state.jobs.findIndex(
            (existing) => existing.key === job.key
          )
          if (index < 0) return { jobs: [...state.jobs, job] }
          const jobs = [...state.jobs]
          jobs[index] = job
          return { jobs }
        }),
      dequeue: (key) =>
        set((state) => ({ jobs: state.jobs.filter((job) => job.key !== key) })),
      setJobPhase: (key, phase) =>
        set((state) => ({
          jobs: state.jobs.map((job) =>
            job.key === key ? { ...job, phase } : job
          ),
        })),
      setPermission: (id, result) =>
        set((state) => ({
          permissions: { ...state.permissions, [id]: result },
        })),
      handOff: (destination) =>
        set({
          phase: 'handedOff',
          destination,
          guide: destination === 'chat' ? null : { path: destination, hint: 0 },
          panelDismissed: false,
        }),
      reopen: () =>
        set((state) =>
          state.phase === 'handedOff' ? { phase: 'active' } : state
        ),
      setGuide: (guide) => set({ guide }),
      dismissPanel: () => set({ panelDismissed: true }),
      finish: () => set({ phase: 'finished', guide: null }),
      reset: () => set(initialData),
    }),
    {
      name: localStorageKey.onboarding,
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (state): OnboardingData => ({
        variant: state.variant,
        phase: state.phase,
        step: state.step,
        startedAt: state.startedAt,
        choice: state.choice,
        jobs: state.jobs,
        permissions: state.permissions,
        destination: state.destination,
        guide: state.guide,
        panelDismissed: state.panelDismissed,
      }),
    }
  )
)
