import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { VoiceEvent } from '@/services/voice/types'

const startSession = vi.hoisted(() =>
  vi.fn(async () => ({
    sessionId: 'monitor-1',
    deviceId: 'mic-2',
    deviceName: 'USB mic',
    sampleRate: 48000,
    resampled: true,
    fellBackToDefault: false,
  }))
)
const cancelSession = vi.hoisted(() => vi.fn(async () => {}))
const emit = vi.hoisted(() => ({
  handler: null as null | ((e: VoiceEvent) => void),
}))
const subscribe = vi.hoisted(() =>
  vi.fn((handler: (event: VoiceEvent) => void) => {
    emit.handler = handler
    return () => {
      emit.handler = null
    }
  })
)

const voice = () => ({ startSession, cancelSession, subscribe })

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ voice }),
  getServiceHub: () => ({ voice }),
}))

import { useMicMonitor } from '../useMicMonitor'

function fire(event: VoiceEvent) {
  emit.handler?.(event)
}

describe('useMicMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    emit.handler = null
    useMicMonitor.setState({
      active: false,
      starting: false,
      sessionId: null,
      level: 0,
      errorKey: null,
    })
  })

  it('opens the microphone without a transcription target', async () => {
    // The whole point: testing a device must not require the 3 GB voice model.
    await useMicMonitor.getState().start('mic-2')

    expect(startSession).toHaveBeenCalledWith({ deviceId: 'mic-2' })
    const call = startSession.mock.calls[0][0] as Record<string, unknown>
    expect(call.baseUrl).toBeUndefined()
    expect(call.model).toBeUndefined()
    expect(useMicMonitor.getState().active).toBe(true)
  })

  it('tracks the level while running', async () => {
    await useMicMonitor.getState().start(null)

    fire({
      type: 'level',
      sessionId: 'monitor-1',
      rms: 0.42,
      db: -8,
      speaking: true,
      elapsedMs: 500,
    })

    expect(useMicMonitor.getState().level).toBeCloseTo(0.42)
  })

  it('ignores level events from a different session', async () => {
    await useMicMonitor.getState().start(null)

    fire({
      type: 'level',
      sessionId: 'someone-elses-session',
      rms: 0.9,
      db: -1,
      speaking: true,
      elapsedMs: 500,
    })

    expect(useMicMonitor.getState().level).toBe(0)
  })

  it('stops and releases the device', async () => {
    await useMicMonitor.getState().start(null)
    await useMicMonitor.getState().stop()

    expect(cancelSession).toHaveBeenCalledWith('monitor-1')
    const state = useMicMonitor.getState()
    expect(state.active).toBe(false)
    expect(state.level).toBe(0)
  })

  it('surfaces a device error and shuts down', async () => {
    await useMicMonitor.getState().start(null)

    fire({
      type: 'error',
      sessionId: 'monitor-1',
      code: 'NO_INPUT_DEVICE',
      message: 'none',
    })

    const state = useMicMonitor.getState()
    expect(state.active).toBe(false)
    expect(state.errorKey).toBe('common:voiceInput.errors.noDevice')
  })

  it('reports a refused start rather than looking stuck', async () => {
    startSession.mockRejectedValueOnce(
      Object.assign(new Error('busy'), { code: 'DEVICE_UNAVAILABLE' })
    )

    await useMicMonitor.getState().start(null)

    const state = useMicMonitor.getState()
    expect(state.active).toBe(false)
    expect(state.starting).toBe(false)
    expect(state.errorKey).toBe('common:voiceInput.errors.deviceBusy')
  })

  it('does not open a second session while one is running', async () => {
    await useMicMonitor.getState().start(null)
    await useMicMonitor.getState().start(null)

    expect(startSession).toHaveBeenCalledTimes(1)
  })
})
