import { create } from 'zustand'

/**
 * Drives the right-hand "Run settings" panel (assistant, context length,
 * model load options, sampling). Deliberately not persisted: the panel is
 * hidden on every launch and only opens on request, though it then survives
 * thread switches within a session.
 */
type RunSettingsPanelState = {
  isOpen: boolean
  open: () => void
  close: () => void
  toggle: () => void
}

export const useRunSettingsPanel = create<RunSettingsPanelState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
}))
