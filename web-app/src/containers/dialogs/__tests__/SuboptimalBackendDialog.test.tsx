import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SuboptimalBackendDialog, {
  BACKEND_PROMPT_IDLE_MS,
} from '@/containers/dialogs/SuboptimalBackendDialog'
import { useBackendMismatch } from '@/hooks/useBackendMismatch'
import { useChatSessions } from '@/stores/chat-session-store'
import { holdModel, resetModelLifecycleForTests } from '@/lib/model-lifecycle'

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const updater = vi.hoisted(() => ({
  recheckOptimalBackend: vi.fn(),
  downloadRecommendedBackend: vi.fn(),
}))
vi.mock('@/hooks/useBackendUpdater', () => ({
  useBackendUpdater: () => ({
    recommendation: null,
    recommendationPhase: 'idle',
    ...updater,
  }),
}))

const reportMismatch = (modelId: string) => {
  const { result } = renderHook(() => useBackendMismatch())
  act(() =>
    result.current.report({
      provider: 'llamacpp-upstream',
      modelId,
      configuredVersionBackend: 'b1/win-vulkan-x64',
      effectiveVersionBackend: 'b1/win-cpu-x64',
      mismatch: {
        kind: 'silent-fallback',
        configured: `vulkan-${modelId}`,
        effective: 'cpu',
      },
    })
  )
}

const setRequestActive = (active: boolean) =>
  act(() => useChatSessions.getState().setRequestActive('thread-1', active))

const prompt = () => screen.queryByRole('dialog')

describe('SuboptimalBackendDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resetModelLifecycleForTests()
    useChatSessions.setState({ sessions: {}, requestActive: {} })
  })
  afterEach(() => vi.useRealTimers())

  // Its Fix unloads the provider's models and its Restart relaunches the app:
  // raised on the first send after a load, either ended the reply just sent.
  it('waits for the turn in flight to finish before it asks', () => {
    render(<SuboptimalBackendDialog />)
    setRequestActive(true)
    reportMismatch('m1')

    act(() => vi.advanceTimersByTime(BACKEND_PROMPT_IDLE_MS * 3))
    expect(prompt()).toBeNull()

    setRequestActive(false)
    expect(prompt()).not.toBeNull()
  })

  it('asks on its own once the app has been idle a while', () => {
    render(<SuboptimalBackendDialog />)
    reportMismatch('m2')
    expect(prompt()).toBeNull()

    act(() => vi.advanceTimersByTime(BACKEND_PROMPT_IDLE_MS))
    expect(prompt()).not.toBeNull()
  })

  it('offers no Fix while a reply is being generated', () => {
    render(<SuboptimalBackendDialog />)
    reportMismatch('m3')
    act(() => vi.advanceTimersByTime(BACKEND_PROMPT_IDLE_MS))
    setRequestActive(true)

    const fix = screen.getByRole('button', {
      name: /settings:backendMismatch.fix/,
    })
    expect(fix).toBeDisabled()
    expect(
      screen.getByText('settings:backendMismatch.waitForReply')
    ).toBeInTheDocument()
  })

  it('refuses the Fix while a request holds one of the provider’s models', () => {
    render(<SuboptimalBackendDialog />)
    reportMismatch('m4')
    act(() => vi.advanceTimersByTime(BACKEND_PROMPT_IDLE_MS))
    const hold = holdModel('llamacpp-upstream', 'm4', 60_000)

    fireEvent.click(
      screen.getByRole('button', { name: /settings:backendMismatch.fix/ })
    )
    expect(toast.info).toHaveBeenCalledWith(
      'settings:backendMismatch.waitForReply'
    )
    expect(updater.recheckOptimalBackend).not.toHaveBeenCalled()
    // The prompt stays open so the user can fix it once the reply is done.
    expect(
      screen.getByRole('button', { name: /settings:backendMismatch.fix/ })
    ).toBeInTheDocument()
    hold.release()
  })
})
