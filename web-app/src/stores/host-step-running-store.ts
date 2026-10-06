import { create } from 'zustand'

/**
 * Privileged steps the person already approved and that are now running (Rust
 * `managed-host-step-running`, sent once UAC was approved and the executor started). Until the step
 * ends the UI says the work is under way — `wsl --install` runs for minutes with no window of its
 * own — instead of asking for an approval that was already given.
 */
export const useRunningHostSteps = create<{
  steps: string[]
  started: (stepId: string) => void
  ended: (stepId: string) => void
}>()((set) => ({
  steps: [],
  started: (stepId) =>
    set(({ steps }) => (steps.includes(stepId) ? { steps } : { steps: [...steps, stepId] })),
  ended: (stepId) => set(({ steps }) => ({ steps: steps.filter((step) => step !== stepId) })),
}))

export const HOST_STEP_RUNNING_EVENT = 'managed-host-step-running'
