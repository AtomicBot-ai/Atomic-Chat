import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

import { localStorageKey } from '@/constants/localStorage'
import { VOICE_LANGUAGES, type VoiceLanguage } from '@/constants/voice'

type VoiceSettingState = {
  /** Set once the user finishes (or closes) the setup wizard. */
  setupCompleted: boolean
  setSetupCompleted: (value: boolean) => void

  /** `cpal::DeviceId` string. Null means "whatever the system default is". */
  inputDeviceId: string | null
  setInputDeviceId: (value: string | null) => void

  languageHint: VoiceLanguage
  setLanguageHint: (value: VoiceLanguage) => void

  /**
   * Insert each phrase as soon as the model finishes it. Turning this off holds
   * everything back until the user presses stop, which is cheaper on a machine
   * that is already busy generating a reply.
   */
  liveTranscription: boolean
  setLiveTranscription: (value: boolean) => void

  /** Remembers that we have shown the OS prompt at least once. */
  micPermissionAsked: boolean
  setMicPermissionAsked: (value: boolean) => void

  /**
   * Let the voice model evict the chat model instead of running alongside it.
   * Off by default: most machines can hold both, and silently unloading the
   * chat model would be a surprising side effect of pressing the microphone.
   */
  unloadChatModelWhileDictating: boolean
  setUnloadChatModelWhileDictating: (value: boolean) => void
}

export const useVoiceSetting = create<VoiceSettingState>()(
  persist(
    (set) => ({
      setupCompleted: false,
      setSetupCompleted: (value) => set({ setupCompleted: value }),

      inputDeviceId: null,
      setInputDeviceId: (value) => set({ inputDeviceId: value }),

      languageHint: 'auto',
      setLanguageHint: (value) => set({ languageHint: value }),

      liveTranscription: true,
      setLiveTranscription: (value) => set({ liveTranscription: value }),

      micPermissionAsked: false,
      setMicPermissionAsked: (value) => set({ micPermissionAsked: value }),

      unloadChatModelWhileDictating: false,
      setUnloadChatModelWhileDictating: (value) =>
        set({ unloadChatModelWhileDictating: value }),
    }),
    {
      name: localStorageKey.settingVoice,
      storage: createJSONStorage(() => localStorage),
      version: 2,
      /**
       * A hint we no longer offer (the list has shrunk at least once) would
       * otherwise stay selected forever: the picker cannot show it and the
       * user cannot clear it. Fall back to `auto`.
       */
      migrate: (persisted) => {
        const state = persisted as Partial<VoiceSettingState> | undefined
        if (
          state?.languageHint &&
          !VOICE_LANGUAGES.includes(state.languageHint)
        ) {
          return { ...state, languageHint: 'auto' }
        }
        return state
      },
    }
  )
)
