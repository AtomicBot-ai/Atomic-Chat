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

// Whether the model is on disk is derived from the provider list and the
// download store; the dialog only cares about the one boolean.
const modelInstalled = vi.hoisted(() => ({ current: false }))
vi.mock('@/hooks/useVoiceModel', () => ({
  useVoiceModel: () => ({
    installed: modelInstalled.current,
    downloading: false,
    progress: 0,
    currentBytes: 0,
    totalBytes: 0,
    download: vi.fn(),
    cancelDownload: vi.fn(),
    remove: vi.fn(),
  }),
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

import en from '@/locales/en/common.json'
import ru from '@/locales/ru/common.json'
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
    modelInstalled.current = false
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

  it('gives every step the same fixed content box', async () => {
    render(<VoiceSetupDialog />)
    const slotClass = () =>
      document.querySelector('[data-testid="voice-setup-slot"]')!.className

    const first = slotClass()
    // A minimum would let the tallest step stretch the dialog, which is the
    // regression this guards: paging must not resize the window.
    expect(first).toMatch(/(^|\s)h-\[\d+px\]/)
    expect(first).not.toContain('min-h-')

    for (const _ of [1, 2]) {
      await act(async () => {
        await userEvent.click(screen.getByText('common:voiceInput.setup.next'))
      })
      expect(slotClass()).toBe(first)
    }
  })

  it('gives every step the same fixed description slot', async () => {
    render(<VoiceSetupDialog />)
    const descClass = () =>
      document.querySelector('[data-testid="voice-setup-description"]')!
        .className

    const first = descClass()
    // One description wrapping to two lines while another fits on one is what
    // made step 1 taller than the rest even after the content box was pinned.
    expect(first).toMatch(/(^|\s)h-\d+/)
    expect(first).not.toContain('min-h-')

    for (const _ of [1, 2]) {
      await act(async () => {
        await userEvent.click(screen.getByText('common:voiceInput.setup.next'))
      })
      expect(descClass()).toBe(first)
    }
  })

  it('keeps every step description short enough for that slot', () => {
    // The slot is two lines of text-sm in a 400px-wide dialog. Allowing ~50
    // characters per line worst case, a description over 100 characters would
    // need a third line and be clipped — so this is the budget the copy has.
    const MAX = 100
    for (const [locale, bundle] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      const setup = bundle.voiceInput.setup
      for (const step of ['intro', 'permission', 'model'] as const) {
        const text = setup[step].description
        expect(
          text.length,
          `${locale} ${step}.description is ${text.length} chars: "${text}"`
        ).toBeLessThanOrEqual(MAX)
      }
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
    // All the same size; only the colour marks where you are.
    expect(dots[0].className).toContain('bg-primary')
    expect(dots[1].className).toContain('bg-muted-foreground/30')
    expect(dots[0].className).toContain('size-2')
    expect(dots[1].className).toContain('size-2')
  })

  it('requests microphone access from the permission step', async () => {
    useVoiceInput.setState({ setupStep: 1 })
    render(<VoiceSetupDialog />)

    await act(async () => {
      // The row shows the short label; the full one is the accessible name.
      await userEvent.click(
        screen.getByRole('button', {
          name: 'common:voiceInput.setup.permission.allow',
        })
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

  it('keeps the dots on the centre line, between the two buttons', () => {
    useVoiceInput.setState({ setupStep: 1 })
    render(<VoiceSetupDialog />)

    // A three-column footer, not `justify-between`: the dots belong to the
    // dialog, so they must not drift when Back appears or disappears.
    const footer = document.querySelector('[data-slot="dialog-footer"]')!
    expect(footer.className).toContain('grid-cols-3')
    // Exactly three columns, with the dots in the middle one — a fourth child
    // (the sr-only step label, say) would wrap the buttons onto a second row.
    expect(footer.children).toHaveLength(3)
    expect(footer.children[1].querySelectorAll('[aria-hidden="true"] > span'))
      .toHaveLength(3)
  })

  it('only allows Done once both prerequisites are in place', async () => {
    // Permission alone is not enough — the model still has to be on disk.
    useVoiceInput.setState({ setupStep: 2, permission: 'granted' })
    getPermission.mockResolvedValue('granted')
    const withoutModel = render(<VoiceSetupDialog />)
    expect(screen.getByTestId('voice-setup-done')).toBeDisabled()
    withoutModel.unmount()

    // Nor is the model on its own.
    modelInstalled.current = true
    useVoiceInput.setState({ setupStep: 2, permission: 'undetermined' })
    getPermission.mockResolvedValue('undetermined')
    const withoutPermission = render(<VoiceSetupDialog />)
    expect(screen.getByTestId('voice-setup-done')).toBeDisabled()
    withoutPermission.unmount()

    useVoiceInput.setState({ setupStep: 2, permission: 'granted' })
    getPermission.mockResolvedValue('granted')
    render(<VoiceSetupDialog />)
    expect(screen.getByTestId('voice-setup-done')).toBeEnabled()
  })

  it('marks setup complete on Done', async () => {
    modelInstalled.current = true
    useVoiceInput.setState({ setupStep: 2, permission: 'granted' })
    getPermission.mockResolvedValue('granted')
    render(<VoiceSetupDialog />)

    await act(async () => {
      await userEvent.click(screen.getByTestId('voice-setup-done'))
    })

    expect(useVoiceSetting.getState().setupCompleted).toBe(true)
    expect(useVoiceInput.getState().setupOpen).toBe(false)
  })

  it('can still be dismissed with the close button when nothing is set up', async () => {
    useVoiceInput.setState({ setupStep: 2 })
    render(<VoiceSetupDialog />)

    expect(screen.getByTestId('voice-setup-done')).toBeDisabled()
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    })

    // Dismissing half-configured is deliberate: the microphone button reopens
    // the wizard on whichever prerequisite is still missing.
    expect(useVoiceInput.getState().setupOpen).toBe(false)
  })
})
