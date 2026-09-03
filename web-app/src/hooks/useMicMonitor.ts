import { create } from 'zustand'

import { getServiceHub } from '@/hooks/useServiceHub'
import { voiceErrorFromNative, voiceErrorMessageKey } from '@/lib/voice/errors'

type MicMonitorState = {
  active: boolean
  starting: boolean
  sessionId: string | null
  /**
   * Written at audio rate. Like the dictation store's `level`, nothing selects
   * this reactively — the meter subscribes imperatively and mutates styles.
   */
  level: number
  /** i18n key of the last failure, or null. */
  errorKey: string | null
  start: (deviceId: string | null) => Promise<void>
  stop: () => Promise<void>
}

/** The event subscription is a resource, not state. */
let unsubscribe: (() => void) | null = null

function detach() {
  unsubscribe?.()
  unsubscribe = null
}

/**
 * Opens the microphone without transcribing anything, so the settings page can
 * show a live level for the selected device.
 *
 * Deliberately separate from `useVoiceInput`: this is not dictation, it has no
 * anchor, no transcript and no engine, and folding it into that state machine
 * would add a mode every consumer has to reason about.
 */
export const useMicMonitor = create<MicMonitorState>()((set, get) => ({
  active: false,
  starting: false,
  sessionId: null,
  level: 0,
  errorKey: null,

  start: async (deviceId) => {
    if (get().active || get().starting) return
    set({ starting: true, errorKey: null, level: 0 })

    try {
      detach()
      unsubscribe = getServiceHub()
        .voice()
        .subscribe((event) => {
          const current = get()
          if (
            'sessionId' in event &&
            event.sessionId &&
            current.sessionId &&
            event.sessionId !== current.sessionId
          ) {
            return
          }

          if (event.type === 'level') {
            set({ level: event.rms })
            return
          }
          if (event.type === 'error') {
            detach()
            set({
              active: false,
              starting: false,
              sessionId: null,
              level: 0,
              errorKey: voiceErrorMessageKey(voiceErrorFromNative(event.code)),
            })
            return
          }
          if (event.type === 'state' && event.state === 'stopped') {
            detach()
            set({ active: false, sessionId: null, level: 0 })
          }
        })

      // No transcription target: capture and level only.
      const session = await getServiceHub()
        .voice()
        .startSession({ deviceId })

      set({ active: true, starting: false, sessionId: session.sessionId })
    } catch (error) {
      detach()
      set({
        active: false,
        starting: false,
        sessionId: null,
        errorKey: voiceErrorMessageKey(
          voiceErrorFromNative((error as { code?: string })?.code)
        ),
      })
    }
  },

  stop: async () => {
    const { sessionId } = get()
    detach()
    set({ active: false, starting: false, level: 0 })
    if (!sessionId) return
    set({ sessionId: null })
    try {
      await getServiceHub().voice().cancelSession(sessionId)
    } catch {
      // Best effort: the session may already be gone.
    }
  },
}))
