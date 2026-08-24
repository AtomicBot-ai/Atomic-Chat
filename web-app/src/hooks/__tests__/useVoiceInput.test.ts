import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { VoiceEvent } from '@/services/voice/types'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// --- voice service ---------------------------------------------------------
const startSession = vi.hoisted(() =>
  vi.fn(async () => ({
    sessionId: 'session-1',
    deviceId: null,
    deviceName: 'Built-in',
    sampleRate: 48000,
    resampled: true,
    fellBackToDefault: false,
  }))
)
const stopSession = vi.hoisted(() => vi.fn(async () => {}))
const cancelSession = vi.hoisted(() => vi.fn(async () => {}))
const getPermission = vi.hoisted(() =>
  vi.fn(async () => 'granted' as const)
)
const emit = vi.hoisted(() => ({ handler: null as null | ((e: VoiceEvent) => void) }))
const subscribe = vi.hoisted(() =>
  vi.fn((handler: (event: VoiceEvent) => void) => {
    emit.handler = handler
    return () => {
      emit.handler = null
    }
  })
)

const voice = () => ({
  startSession,
  stopSession,
  cancelSession,
  getPermission,
  subscribe,
})

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ voice }),
  getServiceHub: () => ({ voice }),
}))

// --- engine ----------------------------------------------------------------
const ensureVoiceEngine = vi.hoisted(() =>
  vi.fn(async () => ({
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: 'k',
    model: 'voxtral',
  }))
)
const isVoiceModelInstalled = vi.hoisted(() => vi.fn(async () => true))

vi.mock('@/lib/voice/engine', () => ({
  ensureVoiceEngine,
  isVoiceModelInstalled,
  keepVoiceEngineWarm: vi.fn(),
  releaseVoiceEngine: vi.fn(),
  errorCodeOf: (error: unknown) =>
    (error as { code?: string } | undefined)?.code,
  VOICE_ENGINE_ERRORS: {
    modelMissing: 'TRANSCRIPTION_MODEL_MISSING',
    unsupported: 'TRANSCRIPTION_UNSUPPORTED',
  },
}))

import { ensureVoiceReady, useVoiceInput } from '../useVoiceInput'
import { useVoiceSetting } from '../useVoiceSetting'

const ANCHOR = { before: 'Draft', after: '' }

function fire(event: VoiceEvent) {
  emit.handler?.(event)
}

describe('useVoiceInput', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    emit.handler = null
    localStorage.clear()
    await useVoiceSetting.persist.rehydrate()
    useVoiceSetting.setState({
      setupCompleted: true,
      liveTranscription: true,
      inputDeviceId: null,
      languageHint: 'auto',
    })
    useVoiceInput.getState().reset()
    useVoiceInput.setState({ setupOpen: false, setupStep: 0, permission: 'unknown' })
    getPermission.mockResolvedValue('granted')
    isVoiceModelInstalled.mockResolvedValue(true)
  })

  it('starts listening once the engine is up', async () => {
    await useVoiceInput.getState().begin('thread-1', ANCHOR)

    const state = useVoiceInput.getState()
    expect(state.phase).toBe('listening')
    expect(state.sessionId).toBe('session-1')
    expect(state.ownerKey).toBe('thread-1')
    expect(startSession).toHaveBeenCalledTimes(1)
  })

  it('opens the setup dialog on the model step when the model is absent', async () => {
    ensureVoiceEngine.mockRejectedValueOnce(
      Object.assign(new Error('missing'), {
        code: 'TRANSCRIPTION_MODEL_MISSING',
      })
    )

    await useVoiceInput.getState().begin('thread-1', ANCHOR)

    const state = useVoiceInput.getState()
    expect(state.phase).toBe('model-missing')
    expect(state.setupOpen).toBe(true)
    expect(state.setupStep).toBe(2)
    expect(startSession).not.toHaveBeenCalled()
  })

  it('reports an unusable backend as a terminal error', async () => {
    ensureVoiceEngine.mockRejectedValueOnce(
      Object.assign(new Error('no audio'), {
        code: 'TRANSCRIPTION_UNSUPPORTED',
      })
    )

    await useVoiceInput.getState().begin('thread-1', ANCHOR)

    const state = useVoiceInput.getState()
    expect(state.phase).toBe('error')
    expect(state.error?.code).toBe('transcriptionUnsupported')
  })

  it('appends finalized phrases in order', async () => {
    await useVoiceInput.getState().begin('thread-1', ANCHOR)

    fire({
      type: 'transcript',
      sessionId: 'session-1',
      index: 0,
      text: 'The quick brown fox.',
      durationMs: 2000,
      latencyMs: 500,
    })
    fire({
      type: 'transcript',
      sessionId: 'session-1',
      index: 1,
      text: 'Jumps over the lazy dog.',
      durationMs: 2000,
      latencyMs: 500,
    })

    expect(useVoiceInput.getState().committed).toBe(
      'The quick brown fox. Jumps over the lazy dog.'
    )
  })

  it('holds phrases back until stop when live insertion is off', async () => {
    useVoiceSetting.setState({ liveTranscription: false })
    await useVoiceInput.getState().begin('thread-1', ANCHOR)

    fire({
      type: 'transcript',
      sessionId: 'session-1',
      index: 0,
      text: 'held back',
      durationMs: 1000,
      latencyMs: 100,
    })
    expect(useVoiceInput.getState().committed).toBe('')

    fire({ type: 'state', sessionId: 'session-1', state: 'stopped' })
    expect(useVoiceInput.getState().committed).toBe('held back')
  })

  it('ignores events from a session it no longer owns', async () => {
    await useVoiceInput.getState().begin('thread-1', ANCHOR)

    fire({
      type: 'transcript',
      sessionId: 'a-stale-session',
      index: 0,
      text: 'should not appear',
      durationMs: 1000,
      latencyMs: 100,
    })

    expect(useVoiceInput.getState().committed).toBe('')
  })

  it('returns to idle when the native session stops', async () => {
    await useVoiceInput.getState().begin('thread-1', ANCHOR)
    fire({
      type: 'transcript',
      sessionId: 'session-1',
      index: 0,
      text: 'done',
      durationMs: 500,
      latencyMs: 50,
    })
    fire({ type: 'state', sessionId: 'session-1', state: 'stopped' })

    const state = useVoiceInput.getState()
    expect(state.phase).toBe('idle')
    expect(state.sessionId).toBeNull()
    expect(state.lastOutcome).toBe('inserted')
  })

  it('cancels without transcribing the tail', async () => {
    await useVoiceInput.getState().begin('thread-1', ANCHOR)
    await useVoiceInput.getState().cancel()

    expect(cancelSession).toHaveBeenCalledWith('session-1')
    const state = useVoiceInput.getState()
    expect(state.phase).toBe('idle')
    expect(state.lastOutcome).toBe('cancelled')
  })

  it('keeps listening after a single failed phrase', async () => {
    await useVoiceInput.getState().begin('thread-1', ANCHOR)

    fire({
      type: 'error',
      sessionId: 'session-1',
      code: 'TRANSCRIPTION_FAILED',
      message: 'boom',
    })

    // A hard phrase is not a reason to close the microphone.
    expect(useVoiceInput.getState().phase).toBe('listening')
    expect(useVoiceInput.getState().error?.code).toBe('transcriptionFailed')
  })

  it('stops on an error the session cannot recover from', async () => {
    await useVoiceInput.getState().begin('thread-1', ANCHOR)

    fire({
      type: 'error',
      sessionId: 'session-1',
      code: 'DEVICE_DISCONNECTED',
      message: 'unplugged',
    })

    const state = useVoiceInput.getState()
    expect(state.phase).toBe('error')
    expect(state.error?.code).toBe('deviceDisconnected')
  })

  it('gives up the ability to undo once the user types', async () => {
    await useVoiceInput.getState().begin('thread-1', ANCHOR)
    expect(useVoiceInput.getState().canRevert).toBe(true)

    useVoiceInput.getState().rebase({ before: 'Draft edited', after: '' })
    expect(useVoiceInput.getState().canRevert).toBe(false)
    expect(useVoiceInput.getState().committed).toBe('')
  })
})

describe('ensureVoiceReady', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    emit.handler = null
    localStorage.clear()
    await useVoiceSetting.persist.rehydrate()
    useVoiceSetting.setState({ setupCompleted: true })
    useVoiceInput.getState().reset()
    useVoiceInput.setState({ setupOpen: false, setupStep: 0 })
    getPermission.mockResolvedValue('granted')
    isVoiceModelInstalled.mockResolvedValue(true)
  })

  it('runs the wizard from the start on a first ever use', async () => {
    useVoiceSetting.setState({ setupCompleted: false })

    await ensureVoiceReady('thread-1', ANCHOR)

    expect(useVoiceInput.getState().setupOpen).toBe(true)
    expect(useVoiceInput.getState().setupStep).toBe(0)
    expect(startSession).not.toHaveBeenCalled()
  })

  it('opens at the permission step when access was denied', async () => {
    getPermission.mockResolvedValue('denied')

    await ensureVoiceReady('thread-1', ANCHOR)

    expect(useVoiceInput.getState().setupStep).toBe(1)
    expect(useVoiceInput.getState().phase).toBe('permission-denied')
    expect(startSession).not.toHaveBeenCalled()
  })

  it('opens at the permission step when access was never requested', async () => {
    getPermission.mockResolvedValue('undetermined')

    await ensureVoiceReady('thread-1', ANCHOR)

    expect(useVoiceInput.getState().setupStep).toBe(1)
    expect(startSession).not.toHaveBeenCalled()
  })

  it('opens at the model step when the model is not installed', async () => {
    isVoiceModelInstalled.mockResolvedValue(false)

    await ensureVoiceReady('thread-1', ANCHOR)

    expect(useVoiceInput.getState().setupStep).toBe(2)
    expect(startSession).not.toHaveBeenCalled()
  })

  it('starts recording when every prerequisite is met', async () => {
    await ensureVoiceReady('thread-1', ANCHOR)

    expect(useVoiceInput.getState().setupOpen).toBe(false)
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(useVoiceInput.getState().phase).toBe('listening')
  })
})
