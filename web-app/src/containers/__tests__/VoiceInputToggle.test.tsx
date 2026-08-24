import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, info: vi.fn() } }))

const voiceInputEnabled = vi.hoisted(() => ({ current: true }))
vi.mock('@/lib/platform/const', () => ({
  PlatformFeatures: new Proxy(
    {},
    { get: () => voiceInputEnabled.current }
  ) as Record<string, boolean>,
}))

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
const getPermission = vi.hoisted(() => vi.fn(async () => 'granted' as const))
const subscribe = vi.hoisted(() => vi.fn(() => () => {}))

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

import VoiceInputToggle from '../VoiceInputToggle'
import { useVoiceInput } from '@/hooks/useVoiceInput'
import { useVoiceSetting } from '@/hooks/useVoiceSetting'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const ANCHOR = { before: '', after: '' }
const captureAnchor = () => ANCHOR

function renderToggle(props: Partial<{ threadKey: string; disabled: boolean }> = {}) {
  return render(
    <VoiceInputToggle
      threadKey={props.threadKey ?? 'thread-1'}
      captureAnchor={captureAnchor}
      disabled={props.disabled}
    />
  )
}

describe('VoiceInputToggle', () => {
  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    voiceInputEnabled.current = true
    localStorage.clear()
    await useVoiceSetting.persist.rehydrate()
    useVoiceSetting.setState({ setupCompleted: true, liveTranscription: true })
    useVoiceInput.getState().reset()
    useVoiceInput.setState({ setupOpen: false, setupStep: 0 })
    getPermission.mockResolvedValue('granted')
    isVoiceModelInstalled.mockResolvedValue(true)
  })

  it('renders nothing on a platform without voice input', () => {
    voiceInputEnabled.current = false
    const { container } = renderToggle()
    expect(container).toBeEmptyDOMElement()
  })

  it('offers to start when idle', () => {
    renderToggle()
    const button = screen.getByRole('button', {
      name: 'common:voiceInput.start',
    })
    expect(button).toHaveAttribute('aria-pressed', 'false')
  })

  it('offers to stop while this composer is recording', () => {
    useVoiceInput.setState({ phase: 'listening', ownerKey: 'thread-1' })
    renderToggle()
    const button = screen.getByRole('button', {
      name: 'common:voiceInput.stop',
    })
    expect(button).toHaveAttribute('aria-pressed', 'true')
  })

  it('still offers to start when another composer owns the microphone', () => {
    // Home and an open thread can both be mounted; only the owner may stop it.
    useVoiceInput.setState({ phase: 'listening', ownerKey: 'another-thread' })
    renderToggle()
    expect(
      screen.getByRole('button', { name: 'common:voiceInput.start' })
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('runs the setup wizard instead of recording on first use', async () => {
    useVoiceSetting.setState({ setupCompleted: false })
    renderToggle()

    await act(async () => {
      await userEvent.click(
        screen.getByRole('button', { name: 'common:voiceInput.start' })
      )
    })

    expect(useVoiceInput.getState().setupOpen).toBe(true)
    expect(useVoiceInput.getState().setupStep).toBe(0)
    expect(startSession).not.toHaveBeenCalled()
  })

  it('starts a session with the stored device and language', async () => {
    useVoiceSetting.setState({ inputDeviceId: 'mic-2', languageHint: 'ru' })
    renderToggle()

    await act(async () => {
      await userEvent.click(
        screen.getByRole('button', { name: 'common:voiceInput.start' })
      )
    })

    expect(startSession).toHaveBeenCalledTimes(1)
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'mic-2', language: 'ru' })
    )
  })

  it('stops the session when pressed while recording', async () => {
    useVoiceInput.setState({
      phase: 'listening',
      ownerKey: 'thread-1',
      sessionId: 'session-1',
    })
    renderToggle()

    await act(async () => {
      await userEvent.click(
        screen.getByRole('button', { name: 'common:voiceInput.stop' })
      )
    })

    expect(stopSession).toHaveBeenCalledWith('session-1')
  })

  it('reports a failed start and does not stay pending', async () => {
    ensureVoiceEngine.mockRejectedValueOnce(new Error('engine down'))
    renderToggle()

    await act(async () => {
      await userEvent.click(
        screen.getByRole('button', { name: 'common:voiceInput.start' })
      )
    })

    expect(useVoiceInput.getState().phase).toBe('error')
    expect(toastError).toHaveBeenCalledWith(
      'common:voiceInput.errors.engineFailed',
      expect.objectContaining({ description: 'engine down' })
    )
  })

  it('is disabled while a reply is streaming, and says why', () => {
    renderToggle({ disabled: true })
    const button = screen.getByRole('button', {
      name: 'common:voiceInput.unavailableWhileStreaming',
    })
    expect(button).toBeDisabled()
  })

  it('stays clickable while streaming if it is the one recording', () => {
    // Otherwise sending a message would strand an unstoppable recording.
    useVoiceInput.setState({ phase: 'listening', ownerKey: 'thread-1' })
    renderToggle({ disabled: true })
    expect(
      screen.getByRole('button', { name: 'common:voiceInput.stop' })
    ).not.toBeDisabled()
  })
})
