import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))

// The model card has its own tests; here it is just "the step-2 content".
vi.mock('@/containers/VoiceModelCard', () => ({
  default: () => <div data-testid="voice-model-card" />,
}))

const requestPermission = vi.hoisted(() => vi.fn(async () => 'granted' as const))
const getPermission = vi.hoisted(() => vi.fn(async () => 'undetermined' as const))
const openSystemMicrophoneSettings = vi.hoisted(() => vi.fn(async () => {}))
const canOpenSystemMicrophoneSettings = vi.hoisted(() => vi.fn(() => true))

const voice = () => ({
  requestPermission,
  getPermission,
  openSystemMicrophoneSettings,
  canOpenSystemMicrophoneSettings,
  subscribe: () => () => {},
})

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ voice }),
  getServiceHub: () => ({ voice }),
}))

import VoiceSetupDialog from './VoiceSetupDialog'
import { useVoiceInput } from '@/hooks/useVoiceInput'
import { useVoiceSetting } from '@/hooks/useVoiceSetting'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** Text blocks in the dialog's header — the part that must not grow per step. */
function headerTexts() {
  const header = document.querySelector('[data-testid="voice-setup-header"]')!
  return Array.from(header.querySelectorAll('h2, p'))
    .map((node) => node.textContent?.trim())
    .filter((text): text is string => Boolean(text))
}

describe('VoiceSetupDialog', () => {
  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.clear()
    await useVoiceSetting.persist.rehydrate()
    useVoiceSetting.setState({ setupCompleted: false })
    useVoiceInput.getState().reset()
    useVoiceInput.setState({
      setupOpen: true,
      setupStep: 0,
      permission: 'undetermined',
    })
    getPermission.mockResolvedValue('undetermined')
  })

  it('leads each step with that step\'s own title and one subtitle', async () => {
    render(<VoiceSetupDialog />)

    // The header carries the step title — not a fixed dialog title stacked on
    // top of a second per-step heading, which is what made this crowded.
    expect(
      screen.getByText('common:voiceInput.setup.intro.title')
    ).toBeInTheDocument()
    expect(
      screen.getByText('common:voiceInput.setup.intro.description')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('common:voiceInput.setup.title')
    ).not.toBeInTheDocument()
  })

  it('keeps the same number of header blocks on every step', async () => {
    render(<VoiceSetupDialog />)
    const introHeader = headerTexts().length

    for (const step of [1, 2] as const) {
      await act(async () => {
        await userEvent.click(
          screen.getByText('common:voiceInput.setup.next')
        )
      })
      expect(headerTexts().length).toBe(introHeader)
    }
  })

  it('walks forward and back through the three steps', async () => {
    render(<VoiceSetupDialog />)

    await act(async () => {
      await userEvent.click(screen.getByText('common:voiceInput.setup.next'))
    })
    expect(useVoiceInput.getState().setupStep).toBe(1)
    expect(
      screen.getByText('common:voiceInput.setup.permission.title')
    ).toBeInTheDocument()

    await act(async () => {
      await userEvent.click(screen.getByText('common:voiceInput.setup.next'))
    })
    expect(useVoiceInput.getState().setupStep).toBe(2)
    expect(screen.getByTestId('voice-model-card')).toBeInTheDocument()

    await act(async () => {
      await userEvent.click(screen.getByText('common:voiceInput.setup.back'))
    })
    expect(useVoiceInput.getState().setupStep).toBe(1)
  })

  it('shows one dot per step and marks the current one', () => {
    render(<VoiceSetupDialog />)
    const dots = document.querySelectorAll('[aria-hidden="true"] > span')
    expect(dots).toHaveLength(3)
    expect(dots[0].className).toContain('w-5')
    expect(dots[1].className).toContain('w-1.5')
  })

  it('requests microphone access from the permission step', async () => {
    useVoiceInput.setState({ setupStep: 1 })
    render(<VoiceSetupDialog />)

    await act(async () => {
      await userEvent.click(
        screen.getByText('common:voiceInput.setup.permission.allow')
      )
    })

    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(useVoiceInput.getState().permission).toBe('granted')
  })

  it('offers a way back when access was denied', async () => {
    useVoiceInput.setState({ setupStep: 1, permission: 'denied' })
    getPermission.mockResolvedValue('denied')
    render(<VoiceSetupDialog />)

    await act(async () => {
      await userEvent.click(
        screen.getByText('common:voiceInput.setup.permission.openSystemSettings')
      )
    })
    expect(openSystemMicrophoneSettings).toHaveBeenCalled()
  })

  it('marks setup complete on Done', async () => {
    useVoiceInput.setState({ setupStep: 2 })
    render(<VoiceSetupDialog />)

    await act(async () => {
      await userEvent.click(screen.getByText('common:voiceInput.setup.done'))
    })

    expect(useVoiceSetting.getState().setupCompleted).toBe(true)
    expect(useVoiceInput.getState().setupOpen).toBe(false)
  })
})
