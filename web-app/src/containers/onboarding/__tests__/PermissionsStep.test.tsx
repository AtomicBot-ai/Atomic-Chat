import '@/test/telemetry-ready'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import '@testing-library/jest-dom'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import posthog from 'posthog-js'

import type { StepContext } from '@/lib/onboarding/steps'
import type { MicPermission } from '@/services/voice/types'
import { useOnboardingStore } from '@/stores/onboarding-store'
import { seedServiceHub } from '@/test/service-hub'

// The notifications row is the desktop app's; tests build as the web app.
const platform = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  const wasTauri = g.IS_TAURI
  g.IS_TAURI = true
  return { wasTauri }
})

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  requestNotifications: vi.fn(async () => true),
  voice: {
    supported: true,
    permission: 'undetermined' as MicPermission,
    request: vi.fn(async (): Promise<MicPermission> => 'granted'),
    openSettings: vi.fn(async () => undefined),
  },
  context: {
    winOrLinux: false,
    backendStepDone: false,
    permissionRows: 1,
    cloudProviders: 0,
    mediaCards: 0,
    localApiServer: false,
  } as StepContext,
}))

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn() },
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key} ${Object.values(vars).join(' ')}` : key,
  }),
}))
vi.mock('@/lib/notifications', () => ({
  requestNotificationPermission: mocks.requestNotifications,
}))
// The shell's other steps are not on screen here; the step list is fixed.
vi.mock('../useStepContext', () => ({
  useStepContext: () => mocks.context,
}))
// The model list has screens and tests of its own (ModelStep.test).
vi.mock('../steps/ModelStep', () => ({ ModelStep: () => null }))

import { Onboarding } from '../Onboarding'
import { PermissionsStep } from '../steps/PermissionsStep'
import { usePermissionRowCount } from '../steps/permissionsAvailability'

const events = (event: string) =>
  vi
    .mocked(posthog.capture)
    .mock.calls.filter(([name]) => name === event)
    .map(([, props]) => props as Record<string, unknown>)

const seedVoice = () =>
  seedServiceHub({
    voice: {
      isSupported: () => mocks.voice.supported,
      getPermission: async () => mocks.voice.permission,
      requestPermission: mocks.voice.request,
      canOpenSystemMicrophoneSettings: () => true,
      openSystemMicrophoneSettings: mocks.voice.openSettings,
    } as never,
  })

const row = (title: string) =>
  screen.getByRole('heading', { name: title }).closest('.ob-permission')!

function renderStep() {
  const next = vi.fn()
  const handOff = vi.fn()
  render(<PermissionsStep next={next} goTo={vi.fn()} handOff={handOff} />)
  return { next, handOff }
}

/** Waits for the microphone's answer to put its row on screen. */
const microphoneRow = async () => {
  await screen.findByRole('heading', {
    name: 'onboarding-permissions:microphone.title',
  })
  return row('onboarding-permissions:microphone.title')
}

// Unmounted before the shared teardown empties the service hub, which every
// row reads.
afterEach(cleanup)
afterAll(() => {
  ;(globalThis as Record<string, unknown>).IS_TAURI = platform.wasTauri
})

describe('permissions step', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useOnboardingStore.getState().reset()
    mocks.requestNotifications.mockResolvedValue(true)
    mocks.voice.supported = true
    mocks.voice.permission = 'undetermined'
    mocks.voice.request.mockResolvedValue('granted')
    seedVoice()
  })

  it('offers notifications and the microphone, and nothing for files', async () => {
    renderStep()
    const microphone = await microphoneRow()

    expect(
      within(row('onboarding-permissions:notifications.title')).getByRole(
        'button',
        { name: 'onboarding-permissions:allow' }
      )
    ).toBeEnabled()
    expect(
      within(microphone).getByRole('button', {
        name: 'onboarding-permissions:allow',
      })
    ).toBeEnabled()
    expect(
      screen.queryByText('onboarding-permissions:files.title')
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'onboarding-permissions:skip' })
    ).toBeInTheDocument()
  })

  it('asks the OS for notifications only after the explanation is accepted', async () => {
    renderStep()
    await microphoneRow()

    fireEvent.click(
      within(row('onboarding-permissions:notifications.title')).getByRole(
        'button',
        { name: 'onboarding-permissions:allow' }
      )
    )
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText('onboarding-permissions:notifications.ask')
    ).toBeInTheDocument()
    expect(mocks.requestNotifications).not.toHaveBeenCalled()

    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'onboarding-permissions:allowAccess',
      })
    )

    expect(
      await within(
        row('onboarding-permissions:notifications.title')
      ).findByText('onboarding-permissions:allowed')
    ).toBeInTheDocument()
    expect(useOnboardingStore.getState().permissions.notifications).toBe(
      'granted'
    )
    expect(events('onboarding_permission')).toEqual([
      expect.objectContaining({
        permission: 'notifications',
        permission_result: 'granted',
      }),
    ])
    expect(
      screen.getByRole('button', { name: 'onboarding:continue' })
    ).toBeInTheDocument()
  })

  it('shows a refused notification request as not allowed', async () => {
    mocks.requestNotifications.mockResolvedValue(false)
    const { next } = renderStep()
    await microphoneRow()

    fireEvent.click(
      within(row('onboarding-permissions:notifications.title')).getByRole(
        'button',
        { name: 'onboarding-permissions:allow' }
      )
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'onboarding-permissions:allowAccess',
      })
    )

    expect(
      await within(
        row('onboarding-permissions:notifications.title')
      ).findByText('onboarding-permissions:notAllowed')
    ).toBeInTheDocument()
    expect(useOnboardingStore.getState().permissions.notifications).toBe(
      'denied'
    )
    expect(events('onboarding_permission')[0]).toMatchObject({
      permission: 'notifications',
      permission_result: 'denied',
    })
    // Nothing allowed yet, so leaving still asks first.
    fireEvent.click(
      screen.getByRole('button', { name: 'onboarding-permissions:skip' })
    )
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'onboarding-permissions:warning.title'
    )
    expect(next).not.toHaveBeenCalled()
  })

  it('leaves the OS alone on "Not now"', async () => {
    renderStep()
    await microphoneRow()

    fireEvent.click(
      within(row('onboarding-permissions:notifications.title')).getByRole(
        'button',
        { name: 'onboarding-permissions:allow' }
      )
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'onboarding-permissions:notNow',
      })
    )

    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(mocks.requestNotifications).not.toHaveBeenCalled()
    expect(useOnboardingStore.getState().permissions).toEqual({})
    expect(events('onboarding_permission')).toEqual([
      expect.objectContaining({
        permission: 'notifications',
        permission_result: 'not_now',
      }),
    ])
  })

  it('offers the privacy pane once the microphone is refused', async () => {
    mocks.voice.request.mockResolvedValue('denied')
    renderStep()
    const microphone = await microphoneRow()

    fireEvent.click(
      within(microphone).getByRole('button', {
        name: 'onboarding-permissions:allow',
      })
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'onboarding-permissions:allowAccess',
      })
    )

    const settings = await within(microphone).findByRole('button', {
      name: 'common:voiceInput.setup.permission.openSystemSettings',
    })
    expect(
      within(microphone).getByText('onboarding-permissions:notAllowed')
    ).toBeInTheDocument()
    expect(useOnboardingStore.getState().permissions.microphone).toBe('denied')
    fireEvent.click(settings)
    expect(mocks.voice.openSettings).toHaveBeenCalledTimes(1)
  })

  it('shows a microphone allowed before as allowed on arrival, and continues without asking', async () => {
    mocks.voice.permission = 'granted'
    const { next } = renderStep()

    const microphone = await microphoneRow()
    expect(
      within(microphone).getByText('onboarding-permissions:allowed')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'onboarding:continue' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(next).toHaveBeenCalledWith('continue')
  })

  // Tauri's desktop notification plugin answers "granted" before anything was
  // asked; trusting it showed the row as allowed and Continue left without the
  // warning (2.2.26 feedback).
  it('keeps notifications on Allow until they are allowed here, so leaving asks first', async () => {
    mocks.voice.permission = 'unsupported'
    const { next } = renderStep()
    await act(async () => {})

    expect(
      within(row('onboarding-permissions:notifications.title')).getByRole(
        'button',
        { name: 'onboarding-permissions:allow' }
      )
    ).toBeEnabled()
    fireEvent.click(
      screen.getByRole('button', { name: 'onboarding-permissions:skip' })
    )

    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'onboarding-permissions:warning.title'
    )
    expect(next).not.toHaveBeenCalled()
  })

  it('shows notifications allowed earlier in this run as allowed', async () => {
    useOnboardingStore.getState().setPermission('notifications', 'granted')
    mocks.voice.permission = 'unsupported'
    const { next } = renderStep()
    await act(async () => {})

    expect(
      within(row('onboarding-permissions:notifications.title')).getByText(
        'onboarding-permissions:allowed'
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'onboarding:continue' }))
    expect(next).toHaveBeenCalledWith('continue')
  })

  it('has no microphone row where the OS manages it', async () => {
    mocks.voice.permission = 'unsupported'
    renderStep()
    await act(async () => {})

    expect(
      screen.getByRole('heading', {
        name: 'onboarding-permissions:notifications.title',
      })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', {
        name: 'onboarding-permissions:microphone.title',
      })
    ).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /allow$/ })).toHaveLength(1)
  })

  it('permission-free continuation requires confirmation and can be cancelled', async () => {
    const { next } = renderStep()
    await microphoneRow()

    fireEvent.click(
      screen.getByRole('button', { name: 'onboarding-permissions:skip' })
    )
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText('onboarding-permissions:warning.body')
    ).toBeInTheDocument()

    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'onboarding-permissions:warning.review',
      })
    )
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(next).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole('button', { name: 'onboarding-permissions:skip' })
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'onboarding-permissions:warning.proceed',
      })
    )
    expect(next).toHaveBeenCalledWith('skip')
  })
})

describe('permission rows this machine has', () => {
  beforeEach(() => {
    mocks.voice.supported = true
    mocks.voice.permission = 'undetermined'
    seedVoice()
  })

  it('counts notifications and a microphone the OS can be asked about', async () => {
    const { result } = renderHook(() => usePermissionRowCount())

    await waitFor(() => expect(result.current).toBe(2))
  })

  it('leaves the microphone out without voice input or an OS that manages it', async () => {
    mocks.voice.supported = false
    const unsupportedBuild = renderHook(() => usePermissionRowCount())
    expect(unsupportedBuild.result.current).toBe(1)

    mocks.voice.supported = true
    mocks.voice.permission = 'unsupported'
    const systemManaged = renderHook(() => usePermissionRowCount())
    await act(async () => {})
    expect(systemManaged.result.current).toBe(1)
  })

  it('counts nothing off the desktop, which hides the step', () => {
    const g = globalThis as Record<string, unknown>
    g.IS_TAURI = false
    mocks.voice.supported = false
    try {
      const { result } = renderHook(() => usePermissionRowCount())
      expect(result.current).toBe(0)
    } finally {
      g.IS_TAURI = true
    }
  })
})

describe('Skip setup on the permissions step', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.voice.supported = false
    seedVoice()
    useOnboardingStore.getState().reset()
    useOnboardingStore.getState().begin('full', 'permissions')
  })

  it('Skip setup on permissions confirms before entering the app', async () => {
    render(<Onboarding />)
    await screen.findByRole('heading', {
      name: 'onboarding-permissions:title',
    })

    fireEvent.click(screen.getByTestId('onboarding-skip'))

    const dialog = await screen.findByRole('dialog')
    expect(useOnboardingStore.getState().phase).toBe('active')
    expect(mocks.navigate).not.toHaveBeenCalled()

    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'onboarding-permissions:warning.proceed',
      })
    )

    expect(useOnboardingStore.getState().phase).toBe('handedOff')
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/', replace: true })
    )
    expect(events('onboarding_step_left')[0]).toMatchObject({
      step: 'permissions',
      step_action: 'skip_setup',
    })
  })

  it('leaves at once once something is allowed', async () => {
    useOnboardingStore.getState().setPermission('notifications', 'granted')
    render(<Onboarding />)
    await screen.findByText('onboarding-permissions:allowed')

    fireEvent.click(screen.getByTestId('onboarding-skip'))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useOnboardingStore.getState().phase).toBe('handedOff')
  })
})
