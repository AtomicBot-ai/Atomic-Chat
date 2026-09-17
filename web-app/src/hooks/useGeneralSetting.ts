import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { ExtensionManager } from '@/lib/extension'
import { hadLegacyPerThreadAgentMode } from '@/lib/legacy-agent-mode'
/**
 * Thinking effort scale shared by the chat-input pill and Settings → General.
 * `max` means the model's own strongest effort value, or no thinking-token cap
 * for models that only take a budget.
 */
export type ReasoningBudgetLevel =
  | 'off'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

/**
 * Longest-edge cap (in pixels) applied to images before they are sent to the
 * model. Large images otherwise flood the context window. `0` disables
 * downscaling. Default keeps quality high while taming 4K photos/screenshots.
 */
export const DEFAULT_MAX_IMAGE_SIZE_PX = 2048

type GeneralSettingState = {
  currentLanguage: Language
  spellCheckChatInput: boolean
  tokenCounterCompact: boolean
  disableReasoning: boolean
  reasoningBudget: ReasoningBudgetLevel
  /**
   * Restore the last used model — and therefore spawn its engine — while the
   * app is starting. Off by default so a cold launch stays cold: the user
   * picks a model in the model selector and only then is one loaded. Existing
   * installs keep whatever they already persisted (no migration on purpose).
   */
  preloadModelOnStartup: boolean
  /**
   * Escape hatch for the unified agent engine: route every turn through the
   * legacy AI-SDK chat pipeline instead of the Rust agent loop. Off by
   * default; planned for removal after two stable releases.
   */
  legacyChatEngine: boolean
  maxImageSizePx: number
  huggingfaceToken?: string
  scanLocalModels: boolean
  localScanFolders: string[]
  // Drives the "New" pill on the Integrations nav item — cleared on first visit.
  integrationsBadgeSeen: boolean
  markIntegrationsBadgeSeen: () => void
  // Same pattern for the Connectors nav item.
  connectorsBadgeSeen: boolean
  markConnectorsBadgeSeen: () => void
  /**
   * Global opt-in for the agent engine. Off = every turn runs on the chat
   * pipeline. Toggled from the composer "+" menu; while on, an "Agent" chip
   * sits in the composer toolbar until the user removes it.
   */
  agentModeEnabled: boolean
  setAgentModeEnabled: (value: boolean) => void
  setHuggingfaceToken: (token: string) => void
  setSpellCheckChatInput: (value: boolean) => void
  setTokenCounterCompact: (value: boolean) => void
  setDisableReasoning: (value: boolean) => void
  setReasoningBudget: (value: ReasoningBudgetLevel) => void
  setPreloadModelOnStartup: (value: boolean) => void
  setLegacyChatEngine: (value: boolean) => void
  setMaxImageSizePx: (value: number) => void
  setCurrentLanguage: (value: Language) => void
  setScanLocalModels: (value: boolean) => void
  addLocalScanFolder: (folder: string) => void
  removeLocalScanFolder: (folder: string) => void
}

export const useGeneralSetting = create<GeneralSettingState>()(
  persist(
    (set) => ({
      currentLanguage: 'en',
      spellCheckChatInput: true,
      tokenCounterCompact: true,
      disableReasoning: true,
      reasoningBudget: 'medium',
      preloadModelOnStartup: false,
      legacyChatEngine: false,
      maxImageSizePx: DEFAULT_MAX_IMAGE_SIZE_PX,
      huggingfaceToken: undefined,
      scanLocalModels: true,
      localScanFolders: [],
      integrationsBadgeSeen: false,
      markIntegrationsBadgeSeen: () =>
        set((state) =>
          state.integrationsBadgeSeen ? state : { integrationsBadgeSeen: true }
        ),
      connectorsBadgeSeen: false,
      markConnectorsBadgeSeen: () =>
        set((state) =>
          state.connectorsBadgeSeen ? state : { connectorsBadgeSeen: true }
        ),
      agentModeEnabled: false,
      setAgentModeEnabled: (value) => set({ agentModeEnabled: value }),
      setSpellCheckChatInput: (value) => set({ spellCheckChatInput: value }),
      setTokenCounterCompact: (value) => set({ tokenCounterCompact: value }),
      setDisableReasoning: (value) => set({ disableReasoning: value }),
      setReasoningBudget: (value) => set({ reasoningBudget: value }),
      setPreloadModelOnStartup: (value) =>
        set({ preloadModelOnStartup: value }),
      setLegacyChatEngine: (value) => set({ legacyChatEngine: value }),
      setMaxImageSizePx: (value) =>
        set({
          maxImageSizePx: Number.isFinite(value) && value > 0 ? value : 0,
        }),
      setCurrentLanguage: (value) => set({ currentLanguage: value }),
      setScanLocalModels: (value) => set({ scanLocalModels: value }),
      addLocalScanFolder: (folder) =>
        set((state) => {
          const trimmed = folder.trim()
          if (!trimmed || state.localScanFolders.includes(trimmed)) return state
          return { localScanFolders: [...state.localScanFolders, trimmed] }
        }),
      removeLocalScanFolder: (folder) =>
        set((state) => ({
          localScanFolders: state.localScanFolders.filter((f) => f !== folder),
        })),
      setHuggingfaceToken: (token) => {
        set({ huggingfaceToken: token })
        ExtensionManager.getInstance()
          .getByName('@janhq/download-extension')
          ?.getSettings()
          .then((settings) => {
            if (settings) {
              const newSettings = settings.map((e) => {
                if (e.key === 'hf-token') {
                  e.controllerProps.value = token
                }
                return e
              })
              ExtensionManager.getInstance()
                .getByName('@janhq/download-extension')
                ?.updateSettings(newSettings)
            }
          })
      },
    }),
    {
      name: localStorageKey.settingGeneral,
      storage: createJSONStorage(() => localStorage),
      version: 4,
      migrate: (persistedState: unknown, version: number) => {
        const state = (persistedState ?? {}) as Partial<GeneralSettingState> &
          Record<string, unknown>
        if (version < 1 && (state.reasoningBudget as string) === 'unlimited') {
          // v0 → v1: the uncapped level joined the effort scale as `max`.
          state.reasoningBudget = 'max'
        }
        if (version < 2) {
          // v1 → v2: reasoning starts off. The default was `false` until
          // 2026-04-29 and the store saves every field, so older installs
          // carried reasoning on without anyone choosing it. Reset once, with
          // the bulb's removal: the effort slider is now the only switch, and
          // its first stop is Off. The chosen level is kept.
          state.disableReasoning = true
        }
        if (version < 3 && hadLegacyPerThreadAgentMode()) {
          // v2 → v3: Agent mode moved from a per-thread flag (`agentThreads`
          // in the `agent-mode` store) to this global toggle, which defaults
          // to off and was never migrated. Users who had been running threads
          // on the agent engine were dropped back onto the chat pipeline —
          // where agent skills never reach the model — with no notice.
          // Carry their choice over.
          state.agentModeEnabled = true
        }
        if (version < 4) {
          // v3 → v4: the composer's Plugins button no longer hides behind a
          // "+" menu pin (`connectorsPinned`); it is a toolbar fixture like
          // the web-search globe. The store saves every field, so an install
          // that had the button unpinned still carries the key — drop it.
          // Each connector's own on/off state lives elsewhere and is kept.
          delete state.connectorsPinned
        }
        return state as GeneralSettingState
      },
    }
  )
)
