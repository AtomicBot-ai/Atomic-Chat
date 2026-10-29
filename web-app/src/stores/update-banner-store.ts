import { useEffect } from 'react'

import { create } from 'zustand'

/**
 * Who currently wants the update banner's place in the corner column.
 *
 * - `app` — a new app version is available (ATO-533).
 * - `engine` — a new inference-engine build is available (ATO-528/531).
 *
 * ATO-533 requires that the app and engine offers never stack: one update
 * offer at a time, the app's first. An engine build being downloaded is a row
 * of the download panel, which sits beside the offer rather than instead of
 * it (`corner/cornerStack`).
 */
export type UpdateBannerSlot = 'app' | 'engine'

/// Highest priority first. The active slot is the first claimed one.
const SLOT_PRIORITY: UpdateBannerSlot[] = ['app', 'engine']

interface UpdateBannerState {
  claimed: Record<UpdateBannerSlot, boolean>
  /// Idempotent: a component calls this on every render pass with its own
  /// visibility, so repeated identical values must not churn the store.
  setSlotVisible: (slot: UpdateBannerSlot, visible: boolean) => void
}

export const useUpdateBannerSlots = create<UpdateBannerState>((set) => ({
  claimed: { app: false, engine: false },
  setSlotVisible: (slot, visible) =>
    set((state) =>
      state.claimed[slot] === visible
        ? state
        : { claimed: { ...state.claimed, [slot]: visible } }
    ),
}))

/** The slot allowed to render right now, or `null` when nothing is claimed. */
export function activeUpdateBannerSlot(
  claimed: Record<UpdateBannerSlot, boolean>
): UpdateBannerSlot | null {
  return SLOT_PRIORITY.find((slot) => claimed[slot]) ?? null
}

/**
 * Registers `slot` as wanting the corner while `wants` is true, and returns
 * whether it actually won it. Callers render only on `true`.
 *
 * The claim is released on unmount, so a banner that is conditionally mounted
 * never leaves a stale claim that would suppress a lower-priority one forever.
 */
export function useUpdateBannerSlot(
  slot: UpdateBannerSlot,
  wants: boolean
): boolean {
  const setSlotVisible = useUpdateBannerSlots((state) => state.setSlotVisible)
  const claimed = useUpdateBannerSlots((state) => state.claimed)

  useEffect(() => {
    setSlotVisible(slot, wants)
  }, [slot, wants, setSlotVisible])

  useEffect(
    () => () => {
      setSlotVisible(slot, false)
    },
    [slot, setSlotVisible]
  )

  return wants && activeUpdateBannerSlot(claimed) === slot
}
