import { create } from 'zustand'

type HeaderOverlayState = {
  // True while a floating control is painted over the page header's top-right
  // corner — today that is the agent workspace's "open files sidebar" button,
  // which is positioned against the window edge rather than laid out in the
  // header. Header content aligned to that same edge (the context gauge) reads
  // this and shifts left so the two never sit on top of each other.
  rightOverlay: boolean
  setRightOverlay: (visible: boolean) => void
}

export const useHeaderOverlay = create<HeaderOverlayState>()((set) => ({
  rightOverlay: false,
  setRightOverlay: (visible) =>
    set((state) =>
      state.rightOverlay === visible ? state : { rightOverlay: visible }
    ),
}))
