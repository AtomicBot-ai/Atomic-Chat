import { create } from 'zustand'

/** The pickers of Server → Engine & model another surface can ask to open. */
export type ServerPickerTarget = 'engine' | 'model'

type ServerPickerRequestState = {
  /** The picker asked for and not opened yet; `null` when nothing waits. */
  target: ServerPickerTarget | null
  /** Bumped on every request, so asking for the same picker again still counts. */
  nonce: number
  request: (target: ServerPickerTarget) => void
  clear: () => void
}

/**
 * A one-shot request to open a picker of Server → Engine & model, raised by
 * the tray's Model and Runtime rows. The click arrives before the page exists
 * (it is navigated to right after), so the request waits here until the page
 * opens that picker, or drops it when it has none to open.
 */
export const useServerPickerRequest = create<ServerPickerRequestState>()(
  (set) => ({
    target: null,
    nonce: 0,
    request: (target) => set(({ nonce }) => ({ target, nonce: nonce + 1 })),
    clear: () => set({ target: null }),
  })
)
