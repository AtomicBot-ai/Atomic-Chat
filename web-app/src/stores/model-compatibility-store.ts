import { create } from 'zustand'

import type {
  CompatibilityVerdict,
  PrismFamily,
} from '@/services/model-setup/types'

/**
 * What the core said about the Hub's files, as this window last heard it: the
 * compatibility verdicts the Hub rows asked for, and the Bonsai families of
 * the PrismML list. Both hold for one core generation; a new one may run
 * another engine or newer model rules, so `reset` forgets them.
 */
type ModelCompatibilityState = {
  /** Verdict per Hub file URL; `null` = asked and the core could not say. */
  verdicts: Record<string, CompatibilityVerdict | null>
  /** The Bonsai families of the Hub's PrismML list; `null` until the core answered. */
  families: PrismFamily[] | null
  setVerdict: (url: string, verdict: CompatibilityVerdict | null) => void
  setFamilies: (families: PrismFamily[]) => void
  reset: () => void
}

export const useModelCompatibilityStore = create<ModelCompatibilityState>(
  (set) => ({
    verdicts: {},
    families: null,
    setVerdict: (url, verdict) =>
      set((state) => ({ verdicts: { ...state.verdicts, [url]: verdict } })),
    setFamilies: (families) => set({ families }),
    reset: () => set({ verdicts: {}, families: null }),
  })
)
