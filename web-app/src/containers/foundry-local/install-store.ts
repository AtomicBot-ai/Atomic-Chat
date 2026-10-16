import { create } from 'zustand'

/**
 * The Foundry Local build this app session just installed or updated to, as `<tag>/<platform>` —
 * the spelling of the accelerators answer's `build`. The provider page's accelerators block prepares
 * every accelerator once it sees that build, then clears the mark: installing the engine prepares
 * its accelerators too (operator decision, rulings/app.md R16), while a later visit prepares nothing
 * by itself.
 */
export const useFoundryLocalInstallStore = create<{ justInstalled: string | null }>(() => ({
  justInstalled: null,
}))
