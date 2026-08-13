import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { ExtensionManager } from '@/lib/extension'
export type ReasoningBudgetLevel =
  | 'off'
  | 'low'
  | 'medium'
  | 'high'
  | 'unlimited'

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
  preloadModelOnStartup: boolean
  maxImageSizePx: number
  huggingfaceToken?: string
  scanLocalModels: boolean
  localScanFolders: string[]
  // Drives the "New" pill on the Integrations nav item — cleared on first visit.
  integrationsBadgeSeen: boolean
  markIntegrationsBadgeSeen: () => void
  setHuggingfaceToken: (token: string) => void
  setSpellCheckChatInput: (value: boolean) => void
  setTokenCounterCompact: (value: boolean) => void
  setDisableReasoning: (value: boolean) => void
  setReasoningBudget: (value: ReasoningBudgetLevel) => void
  setPreloadModelOnStartup: (value: boolean) => void
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
      preloadModelOnStartup: true,
      maxImageSizePx: DEFAULT_MAX_IMAGE_SIZE_PX,
      huggingfaceToken: undefined,
      scanLocalModels: true,
      localScanFolders: [],
      integrationsBadgeSeen: false,
      markIntegrationsBadgeSeen: () =>
        set((state) =>
          state.integrationsBadgeSeen ? state : { integrationsBadgeSeen: true }
        ),
      setSpellCheckChatInput: (value) => set({ spellCheckChatInput: value }),
      setTokenCounterCompact: (value) => set({ tokenCounterCompact: value }),
      setDisableReasoning: (value) => set({ disableReasoning: value }),
      setReasoningBudget: (value) => set({ reasoningBudget: value }),
      setPreloadModelOnStartup: (value) => set({ preloadModelOnStartup: value }),
      setMaxImageSizePx: (value) =>
        set({ maxImageSizePx: Number.isFinite(value) && value > 0 ? value : 0 }),
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
    }
  )
)
