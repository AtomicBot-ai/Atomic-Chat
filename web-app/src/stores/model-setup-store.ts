import { create } from 'zustand'

import { advanceSpeedSample, type SpeedSample } from '@/lib/downloadFormat'
import { mergeSetup, type TaskProgress } from '@/lib/model-setup'
import type {
  CompatibilityVerdict,
  ModelSetup,
  ModelSetupEvent,
} from '@/services/model-setup/types'

/**
 * The core's model setups as this window last heard of them, the bytes of
 * their downloads by task id (and how fast they come), and the compatibility
 * verdicts the Hub already asked for. Setups outlive the sheet that started them: closing it, or the
 * whole app, leaves the operation running in the core, and this store is what
 * finds it again.
 */
type ModelSetupState = {
  setups: Record<string, ModelSetup>
  progress: Record<string, TaskProgress>
  /** Smoothed bytes/second per task id, for the download panel's row. */
  speeds: Record<string, SpeedSample>
  /** Verdict per Hub file URL; `null` = asked and the core could not say. */
  verdicts: Record<string, CompatibilityVerdict | null>
  apply: (event: ModelSetupEvent) => void
  replaceAll: (setups: ModelSetup[]) => void
  setVerdict: (url: string, verdict: CompatibilityVerdict | null) => void
}

export const useModelSetupStore = create<ModelSetupState>((set) => ({
  setups: {},
  progress: {},
  speeds: {},
  verdicts: {},
  apply: (event) => {
    switch (event.type) {
      case 'changed':
        set((state) => ({ setups: mergeSetup(state.setups, event.setup) }))
        return
      case 'progress':
        set((state) => ({
          progress: {
            ...state.progress,
            [event.taskId]: {
              transferred: event.transferred,
              total: event.total,
            },
          },
          speeds: {
            ...state.speeds,
            [event.taskId]: advanceSpeedSample(
              state.speeds[event.taskId],
              event.transferred
            ),
          },
        }))
        return
      case 'reset':
        // A new core generation: what the old one said may no longer hold,
        // and an installed engine may have changed the verdicts.
        set({ verdicts: {} })
        return
    }
  },
  replaceAll: (setups) =>
    set(() => ({
      setups: setups.reduce<Record<string, ModelSetup>>(
        (acc, setup) => mergeSetup(acc, setup),
        {}
      ),
    })),
  setVerdict: (url, verdict) =>
    set((state) => ({ verdicts: { ...state.verdicts, [url]: verdict } })),
}))
