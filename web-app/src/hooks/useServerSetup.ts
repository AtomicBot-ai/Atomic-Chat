import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { localStorageKey } from '@/constants/localStorage'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'

/** Where the setup guide opens: its first question, or a step already chosen. */
export type SetupGuideEntry =
  | { path: 'choose' }
  | { path: 'agent'; agentId?: string }
  | { path: 'endpoint' }

type ServerSetupState = {
  /** The guide ran to the end once. See `useSetupDone` for "set up". */
  setupDone: boolean
  /** The user closed the first-visit guide; "Guide me" still opens it. */
  setupDismissed: boolean
  /**
   * Tools set up through Atomic Chat (the guide or All integrations), newest
   * last. "Configured", not "connected": nothing tells the app whether a tool
   * actually talks to the server.
   */
  configuredAgents: { id: string; at: number }[]
  /**
   * Tools the user removed from the list. Their own config may still point
   * here, so detection must not bring them back; setting one up again does.
   */
  forgottenAgents: string[]
  /** The guide prepared an endpoint for the user's own application. */
  endpointConfigured: boolean
  /** Session only: where the guide starts when it was opened on purpose. */
  guide: SetupGuideEntry | null
  /** Session only: bumped by every `openGuide`, so Overview starts it afresh. */
  guideRevision: number
  /** Session only: the guide is on screen and stays until it is closed. */
  guideActive: boolean
  openGuide: (entry?: SetupGuideEntry) => void
  /** The guide keeps itself open once shown, through to its success screen. */
  holdGuide: () => void
  closeGuide: () => void
  finishSetup: () => void
  markAgentConfigured: (id: string) => void
  /**
   * Tools found already pointing at this server (set up by an earlier
   * release, before this list existed). Adds the ones not listed yet, except
   * those the user removed.
   */
  adoptAgents: (ids: string[]) => void
  markEndpointConfigured: () => void
  forgetAgent: (id: string) => void
  forgetEndpoint: () => void
}

export const useServerSetup = create<ServerSetupState>()(
  persist(
    (set) => ({
      setupDone: false,
      setupDismissed: false,
      configuredAgents: [],
      forgottenAgents: [],
      endpointConfigured: false,
      guide: null,
      guideRevision: 0,
      guideActive: false,
      openGuide: (entry = { path: 'choose' }) =>
        set((state) => ({
          guide: entry,
          guideRevision: state.guideRevision + 1,
          guideActive: true,
        })),
      holdGuide: () => set({ guideActive: true }),
      closeGuide: () =>
        set((state) => ({
          guide: null,
          guideActive: false,
          setupDismissed: state.setupDismissed || !state.setupDone,
        })),
      finishSetup: () => set({ setupDone: true }),
      markAgentConfigured: (id) =>
        set((state) => ({
          configuredAgents: [
            ...state.configuredAgents.filter((agent) => agent.id !== id),
            { id, at: Date.now() },
          ],
          forgottenAgents: state.forgottenAgents.filter(
            (agent) => agent !== id
          ),
        })),
      adoptAgents: (ids) =>
        set((state) => {
          const known = new Set([
            ...state.configuredAgents.map((agent) => agent.id),
            ...state.forgottenAgents,
          ])
          const found = [...new Set(ids)].filter((id) => !known.has(id))
          if (found.length === 0) return state
          const at = Date.now()
          return {
            configuredAgents: [
              ...found.map((id) => ({ id, at })),
              ...state.configuredAgents,
            ],
          }
        }),
      markEndpointConfigured: () => set({ endpointConfigured: true }),
      forgetAgent: (id) =>
        set((state) => ({
          configuredAgents: state.configuredAgents.filter(
            (agent) => agent.id !== id
          ),
          forgottenAgents: [
            ...state.forgottenAgents.filter((agent) => agent !== id),
            id,
          ],
        })),
      forgetEndpoint: () => set({ endpointConfigured: false }),
    }),
    {
      name: localStorageKey.serverSetup,
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (state) => ({
        setupDone: state.setupDone,
        setupDismissed: state.setupDismissed,
        configuredAgents: state.configuredAgents,
        forgottenAgents: state.forgottenAgents,
        endpointConfigured: state.endpointConfigured,
      }),
    }
  )
)

/**
 * Whether the server counts as set up: the guide ran to the end, or the
 * server has already served a model — it was in use before the guide
 * existed, or was set up some other way — so its user is not sent through
 * first-visit setup.
 */
export function useSetupDone(): boolean {
  const done = useServerSetup((state) => state.setupDone)
  const used = useLocalApiServer((state) => state.lastServerModels.length > 0)
  return done || used
}

/** Whether Overview shows the guide: opened on purpose, or a first visit. */
export function useSetupGuideVisible(): boolean {
  const setupDone = useSetupDone()
  const active = useServerSetup((state) => state.guideActive)
  const dismissed = useServerSetup((state) => state.setupDismissed)
  return active || (!setupDone && !dismissed)
}
