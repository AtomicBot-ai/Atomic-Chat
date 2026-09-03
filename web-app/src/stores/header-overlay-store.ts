import { create } from 'zustand'

type HeaderOverlayState = {
  // How many floating 32px controls are painted over the page header's
  // top-right corner — today the agent workspace's "run settings" and "open
  // files sidebar" buttons, which are positioned against the window edge
  // rather than laid out in the header. Header content aligned to that same
  // edge (the context gauge) reads this and shifts left so they never overlap.
  rightOverlayButtons: number
  setRightOverlayButtons: (count: number) => void
}

export const useHeaderOverlay = create<HeaderOverlayState>()((set) => ({
  rightOverlayButtons: 0,
  setRightOverlayButtons: (count) =>
    set((state) =>
      state.rightOverlayButtons === count
        ? state
        : { rightOverlayButtons: count }
    ),
}))
