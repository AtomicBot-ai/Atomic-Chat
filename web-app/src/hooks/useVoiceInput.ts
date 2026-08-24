import { create } from 'zustand'

import { VOICE_ACTIVE_PHASES } from '@/constants/voice'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useVoiceSetting } from '@/hooks/useVoiceSetting'
import {
  ensureVoiceEngine,
  errorCodeOf,
  isVoiceModelInstalled,
  keepVoiceEngineWarm,
  VOICE_ENGINE_ERRORS,
} from '@/lib/voice/engine'
import {
  isTerminalVoiceError,
  voiceErrorFromNative,
  type VoiceErrorCode,
} from '@/lib/voice/errors'
import { appendSegment, type DictationAnchor } from '@/lib/voice/promptMerge'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import type { MicPermission, VoiceEvent } from '@/services/voice/types'

/**
 * Where a dictation session is.
 *
 * `cancelled` is deliberately *not* a phase — it is an outcome. Modelling it as
 * a state creates a dead node every consumer has to remember to clear.
 *
 * In live mode `listening` and "a phrase is being transcribed" coexist, so the
 * phase stays `listening` and `segmentInFlight` toggles instead.
 * `transcribing` is only reached when live insertion is switched off, where
 * there genuinely is nothing left to listen to.
 */
export type VoicePhase =
  | 'idle'
  | 'checking'
  | 'requesting-permission'
  | 'permission-denied'
  | 'model-missing'
  | 'starting'
  | 'listening'
  | 'transcribing'
  | 'finalizing'
  | 'error'

export type VoiceOutcome = 'inserted' | 'cancelled' | 'error' | null

export type VoiceSetupStep = 0 | 1 | 2

type VoiceInputState = {
  phase: VoicePhase
  sessionId: string | null
  /**
   * Which composer owns the microphone — `ChatInput`'s `agentModeKey`. Two
   * composers can be mounted at once (home and a thread), and only the one that
   * started the session may stop it or receive its text.
   */
  ownerKey: string | null
  startedAt: number | null

  /**
   * Written at audio rate. Nothing selects this reactively: `VoiceLevelMeter`
   * subscribes imperatively and mutates styles, because a 20 Hz store update
   * flowing into a 2900-line composer would re-render it twenty times a second.
   */
  level: number

  /** Finalized phrases already spliced into the prompt. */
  committed: string
  /** Phrases held back because live insertion is off. Flushed on stop. */
  buffer: string
  /** The phrase currently being transcribed — shown in the bar, never in the box. */
  interim: string
  segmentInFlight: boolean

  permission: MicPermission | 'unknown'
  error: { code: VoiceErrorCode; message?: string } | null
  lastOutcome: VoiceOutcome

  /** Splice point captured when dictation started. */
  anchor: DictationAnchor | null
  insertedLength: number
  /** False once the user hand-edits: cancelling then keeps the text. */
  canRevert: boolean

  setupOpen: boolean
  setupStep: VoiceSetupStep

  begin: (ownerKey: string, anchor: DictationAnchor) => Promise<void>
  stop: () => Promise<void>
  cancel: () => Promise<void>
  rebase: (anchor: DictationAnchor) => void
  noteInserted: (length: number) => void
  fail: (code: VoiceErrorCode, message?: string) => void
  reset: () => void
  setPermission: (permission: MicPermission) => void
  refreshPermission: () => Promise<MicPermission>
  openSetup: (step?: VoiceSetupStep) => void
  closeSetup: () => void
}

const IDLE = {
  phase: 'idle' as VoicePhase,
  sessionId: null,
  ownerKey: null,
  startedAt: null,
  level: 0,
  committed: '',
  buffer: '',
  interim: '',
  segmentInFlight: false,
  error: null,
  anchor: null,
  insertedLength: 0,
  canRevert: true,
}

/**
 * Event subscription lives outside the store: it is a resource, not state, and
 * putting an unsubscribe function in zustand makes every snapshot unequal.
 */
let unsubscribe: (() => void) | null = null

function detach() {
  unsubscribe?.()
  unsubscribe = null
}

export const useVoiceInput = create<VoiceInputState>()((set, get) => ({
  ...IDLE,
  permission: 'unknown',
  lastOutcome: null,
  setupOpen: false,
  setupStep: 0,

  begin: async (ownerKey, anchor) => {
    if (get().phase !== 'idle' && get().phase !== 'error') return

    set({
      ...IDLE,
      ownerKey,
      anchor,
      phase: 'starting',
      lastOutcome: null,
    })

    try {
      const settings = useVoiceSetting.getState()
      const target = await ensureVoiceEngine({
        keepChatModelLoaded: !settings.unloadChatModelWhileDictating,
      })

      detach()
      unsubscribe = getServiceHub()
        .voice()
        .subscribe((event) => handleEvent(set, get, event))

      const session = await getServiceHub().voice().startSession({
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        model: target.model,
        language: settings.languageHint,
        deviceId: settings.inputDeviceId,
      })

      set({
        sessionId: session.sessionId,
        phase: 'listening',
        startedAt: Date.now(),
      })
    } catch (error) {
      detach()
      const code = errorCodeOf(error)
      if (code === VOICE_ENGINE_ERRORS.modelMissing) {
        set({ phase: 'model-missing', setupOpen: true, setupStep: 2 })
        return
      }
      if (code === VOICE_ENGINE_ERRORS.unsupported) {
        get().fail('transcriptionUnsupported', String(error))
        return
      }
      get().fail(
        'engineFailed',
        error instanceof Error ? error.message : String(error)
      )
    }
  },

  stop: async () => {
    const { sessionId, phase } = get()
    if (!sessionId || !VOICE_ACTIVE_PHASES.has(phase)) return

    const live = useVoiceSetting.getState().liveTranscription
    set({ phase: live ? 'finalizing' : 'transcribing' })
    try {
      await getServiceHub().voice().stopSession(sessionId)
    } catch (error) {
      get().fail(
        'internal',
        error instanceof Error ? error.message : String(error)
      )
    }
  },

  cancel: async () => {
    const { sessionId } = get()
    detachOnIdle(set)
    if (!sessionId) {
      set({ ...IDLE, lastOutcome: 'cancelled' })
      return
    }
    try {
      await getServiceHub().voice().cancelSession(sessionId)
    } catch {
      // Cancelling is best-effort: the session may already be gone.
    }
    set({ ...IDLE, lastOutcome: 'cancelled' })
  },

  // The user typed while dictating. Everything so far — theirs and ours —
  // becomes the new baseline, and the session can no longer be cleanly undone.
  rebase: (anchor) =>
    set({ anchor, committed: '', insertedLength: 0, canRevert: false }),

  noteInserted: (length) => set({ insertedLength: length }),

  fail: (code, message) => {
    detach()
    set({
      ...IDLE,
      phase: 'error',
      error: { code, message },
      lastOutcome: 'error',
      // Keep the owner: the composer that started the session is the one that
      // has to show the error. `reset()` clears it a moment later.
      ownerKey: get().ownerKey,
      // Keep whatever was already inserted; it is the user's text now.
      committed: get().committed,
      anchor: get().anchor,
      insertedLength: get().insertedLength,
      canRevert: false,
    })
  },

  reset: () => {
    detach()
    set({ ...IDLE, lastOutcome: null })
  },

  setPermission: (permission) => set({ permission }),

  refreshPermission: async () => {
    const permission = await getServiceHub().voice().getPermission()
    set({ permission })
    return permission
  },

  openSetup: (step = 0) => set({ setupOpen: true, setupStep: step }),
  closeSetup: () => set({ setupOpen: false }),
}))

function detachOnIdle(set: (partial: Partial<VoiceInputState>) => void) {
  detach()
  set({ level: 0 })
}

function handleEvent(
  set: (partial: Partial<VoiceInputState>) => void,
  get: () => VoiceInputState,
  event: VoiceEvent
) {
  const current = get()
  // Late events from a session we already tore down must not resurrect it.
  if ('sessionId' in event && event.sessionId && current.sessionId) {
    if (event.sessionId !== current.sessionId) return
  }

  switch (event.type) {
    case 'level':
      set({ level: event.rms })
      return

    case 'segment':
      set({ segmentInFlight: true })
      return

    case 'transcript': {
      keepVoiceEngineWarm()
      const live = useVoiceSetting.getState().liveTranscription
      if (live) {
        set({
          committed: appendSegment(current.committed, event.text),
          interim: '',
          segmentInFlight: false,
        })
      } else {
        set({
          buffer: appendSegment(current.buffer, event.text),
          interim: event.text,
          segmentInFlight: false,
        })
      }
      return
    }

    case 'state': {
      if (event.state === 'stopped') {
        detach()
        const merged = appendSegment(current.committed, current.buffer)
        set({
          phase: 'idle',
          sessionId: null,
          startedAt: null,
          level: 0,
          interim: '',
          buffer: '',
          segmentInFlight: false,
          committed: merged,
          lastOutcome:
            event.reason === 'cancelled'
              ? 'cancelled'
              : merged
                ? 'inserted'
                : null,
        })
      }
      return
    }

    case 'error': {
      const code = voiceErrorFromNative(event.code)
      if (isTerminalVoiceError(code)) {
        get().fail(code, event.message)
      } else {
        // A phrase failed but the microphone is still open — keep going.
        set({ segmentInFlight: false, error: { code, message: event.message } })
      }
      return
    }
  }
}

/**
 * Walk the prerequisites and either start dictating or open the setup dialog at
 * the first unmet step.
 *
 * Self-healing by design: because the dialog always opens where the user
 * actually is, closing it early is harmless — the next click on the microphone
 * re-derives the state from scratch.
 */
export async function ensureVoiceReady(
  ownerKey: string,
  anchor: DictationAnchor
): Promise<void> {
  const store = useVoiceInput.getState()

  if (!PlatformFeatures[PlatformFeature.VOICE_INPUT]) return

  if (!useVoiceSetting.getState().setupCompleted) {
    store.openSetup(0)
    return
  }

  const permission = await store.refreshPermission()
  if (permission === 'denied') {
    useVoiceInput.setState({ phase: 'permission-denied' })
    store.openSetup(1)
    return
  }
  if (permission === 'undetermined') {
    store.openSetup(1)
    return
  }

  if (!(await isVoiceModelInstalled())) {
    useVoiceInput.setState({ phase: 'model-missing' })
    store.openSetup(2)
    return
  }

  await store.begin(ownerKey, anchor)
}
