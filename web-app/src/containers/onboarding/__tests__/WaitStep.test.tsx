import '@/test/telemetry-ready'
import {
  act,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import posthog from 'posthog-js'
import {
  registerEmailReminder,
  EmailReminderError,
} from '@/services/email-reminders'
import {
  readEmailReminder,
  useEmailReminderStore,
} from '@/stores/email-reminder-store'

import { localStorageKey } from '@/constants/localStorage'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { OnboardingJob } from '@/lib/onboarding/jobs'
import type { StepContext } from '@/lib/onboarding/steps'
import {
  useOnboardingStore,
  type OnboardingChoice,
} from '@/stores/onboarding-store'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  context: {
    winOrLinux: false,
    backendStepDone: false,
    permissionRows: 0,
    cloudProviders: 0,
    mediaCards: 0,
    localApiServer: true,
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
vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => ({}) }))
vi.mock('@/services/email-reminders', async (original) => ({
  ...(await original<typeof import('@/services/email-reminders')>()),
  registerEmailReminder: vi.fn(),
}))
vi.mock('../useStepContext', () => ({
  useStepContext: () => mocks.context,
}))
const reminder = vi.hoisted(() => ({ offered: true }))
vi.mock('../steps/waitAvailability', () => ({
  get EMAIL_REMINDER_OFFERED() {
    return reminder.offered
  },
}))
// The model list has screens and tests of its own (ModelStep.test).
vi.mock('../steps/ModelStep', () => ({
  ModelStep: () => <h1 tabIndex={-1}>model step</h1>,
}))

import { Onboarding } from '../Onboarding'

const named = (event: string) =>
  vi
    .mocked(posthog.capture)
    .mock.calls.filter(([name]) => name === event)
    .map(([, props]) => props as Record<string, unknown>)

const click = (name: RegExp | string) =>
  fireEvent.click(screen.getByRole('button', { name }))

const QWEN: OnboardingChoice = {
  source: 'download',
  provider: 'llamacpp-upstream',
  modelId: 'Qwen3.5-4B-Q4_K_M',
  title: 'Qwen3.5 4B',
  matchIds: ['Qwen3.5-4B-Q4_K_M'],
}

const QWEN_JOB: OnboardingJob = {
  key: 'chat',
  kind: 'chat',
  title: 'Qwen3.5 4B',
  taskId: 'Qwen3.5-4B-Q4_K_M',
  totalBytes: 2_700_000_000,
  phase: 'running',
}

/** The local engine, with the chosen model registered once it is ready. */
const setInstalled = (ready: boolean) =>
  useModelProvider.setState({
    providers: [
      {
        provider: 'llamacpp-upstream',
        active: true,
        persist: true,
        settings: [],
        models: ready ? [{ id: QWEN.modelId }] : [],
      },
    ],
  } as never)

const startAt = (step: 'purpose' | 'wait', jobs: OnboardingJob[]) => {
  const store = useOnboardingStore.getState()
  store.begin('full', step)
  store.choose(QWEN)
  for (const job of jobs) store.enqueue(job)
}

describe('the wait screen', () => {
  beforeEach(() => {
    vi.mocked(posthog.capture).mockClear()
    mocks.navigate.mockClear()
    localStorage.clear()
    useEmailReminderStore.setState(readEmailReminder())
    vi.mocked(registerEmailReminder).mockReset().mockResolvedValue(undefined)
    useOnboardingStore.getState().reset()
    setInstalled(false)
    reminder.offered = true
  })

  it('follows everyday use while the model downloads, under the purpose counter', () => {
    startAt('purpose', [QWEN_JOB])
    render(<Onboarding />)

    click(/onboarding-server:purpose\.everyday/)

    expect(
      screen.getByRole('heading', { name: 'onboarding-wait:title' })
    ).toHaveFocus()
    expect(screen.getByText('onboarding:stepOf 03 03')).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'onboarding:download.label' })
    ).toHaveTextContent('Qwen3.5 4B')
    expect(useOnboardingStore.getState()).toMatchObject({
      phase: 'active',
      step: 'wait',
    })
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(localStorage.getItem(localStorageKey.setupCompleted)).toBeNull()
    expect(named('onboarding_step_left')[0]).toMatchObject({
      step: 'purpose',
      step_action: 'everyday',
    })

    click(/onboarding:back/)
    expect(useOnboardingStore.getState().step).toBe('purpose')
  })

  it('goes straight to the chat when the model is ready already', () => {
    setInstalled(true)
    startAt('purpose', [{ ...QWEN_JOB, phase: 'done' }])
    render(<Onboarding />)

    click(/onboarding-server:purpose\.everyday/)

    expect(useOnboardingStore.getState()).toMatchObject({
      phase: 'handedOff',
      destination: 'chat',
    })
  })

  it('opens the app to explore while the download carries on', () => {
    startAt('wait', [QWEN_JOB])
    render(<Onboarding />)

    click(/onboarding-wait:explore/)

    expect(useOnboardingStore.getState()).toMatchObject({
      phase: 'handedOff',
      destination: 'chat',
    })
    expect(useOnboardingStore.getState().jobs[0].phase).toBe('running')
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/', replace: true })
    )
    expect(named('onboarding_step_left')[0]).toMatchObject({
      step: 'wait',
      step_action: 'explore',
    })
  })

  it('leaves the email reminder out when the feature is disabled', () => {
    reminder.offered = false
    startAt('wait', [QWEN_JOB])
    render(<Onboarding />)

    expect(
      screen.getByRole('heading', { name: 'onboarding-wait:title' })
    ).toBeInTheDocument()
    expect(
      screen.queryByLabelText('onboarding-wait:email.label')
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'onboarding-wait:playGame' })
    ).toBeInTheDocument()
  })

  it('registers the reminder before confirming, without keeping or reporting the address', async () => {
    reminder.offered = true
    startAt('wait', [QWEN_JOB])
    render(<Onboarding />)
    const field = screen.getByLabelText('onboarding-wait:email.label')

    fireEvent.change(field, { target: { value: 'me@example.com' } })
    fireEvent.submit(field.closest('form')!)

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'onboarding-wait:email.done'
      )
    )
    expect(registerEmailReminder).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        email: 'me@example.com',
        model_name: QWEN.title,
      })
    )
    expect(field).toHaveValue('')
    expect(named('onboarding_reminder_requested')).toHaveLength(1)
    expect(JSON.stringify(vi.mocked(posthog.capture).mock.calls)).not.toContain(
      'me@example.com'
    )
    expect(JSON.stringify(localStorage)).not.toContain('me@example.com')

    // Typing again takes the confirmation back.
    fireEvent.change(field, { target: { value: 'm' } })
    expect(screen.getByRole('status')).not.toHaveTextContent(
      'onboarding-wait:email.done'
    )
  })

  it('blocks duplicate submissions until the API accepts the address', async () => {
    let finish!: () => void
    vi.mocked(registerEmailReminder).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    startAt('wait', [QWEN_JOB])
    render(<Onboarding />)
    const field = screen.getByLabelText('onboarding-wait:email.label')
    fireEvent.change(field, { target: { value: 'me@example.com' } })
    fireEvent.submit(field.closest('form')!)
    fireEvent.submit(field.closest('form')!)
    expect(field).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(
      'onboarding-wait:email.saving'
    )
    expect(named('onboarding_reminder_requested')).toHaveLength(0)
    await waitFor(() => expect(registerEmailReminder).toHaveBeenCalledTimes(1))
    await act(async () => {
      finish()
    })
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'onboarding-wait:email.done'
      )
    )
  })

  it.each([
    [new TypeError('offline'), 'error'],
    [new EmailReminderError(422), 'invalid'],
    [new EmailReminderError(429), 'rateLimited'],
  ])(
    'keeps the address and offers an explicit retry after %s',
    async (error, key) => {
      vi.mocked(registerEmailReminder).mockRejectedValueOnce(error)
      startAt('wait', [QWEN_JOB])
      render(<Onboarding />)
      const field = screen.getByLabelText('onboarding-wait:email.label')
      fireEvent.change(field, { target: { value: 'me@example.com' } })
      fireEvent.submit(field.closest('form')!)
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(
          `onboarding-wait:email.${key}`
        )
      )
      expect(field).toHaveValue('me@example.com')
      expect(field).not.toBeDisabled()
      expect(named('onboarding_reminder_requested')).toHaveLength(0)
      fireEvent.submit(field.closest('form')!)
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(
          'onboarding-wait:email.done'
        )
      )
    }
  )

  it('shows and hides Atomic Mines', () => {
    startAt('wait', [QWEN_JOB])
    render(<Onboarding />)

    click('onboarding-wait:playGame')
    const board = screen.getByRole('group', {
      name: 'onboarding-wait:mines.board',
    })
    expect(within(board).getAllByRole('button')).toHaveLength(64)
    expect(named('onboarding_wait_game')).toHaveLength(1)

    click('onboarding-wait:hideGame')
    expect(
      screen.queryByRole('group', { name: 'onboarding-wait:mines.board' })
    ).not.toBeInTheDocument()
  })

  it('turns into the ready screen once the model can answer, keeping a game under way', () => {
    reminder.offered = true
    startAt('wait', [QWEN_JOB])
    render(<Onboarding />)
    click('onboarding-wait:playGame')

    act(() => {
      setInstalled(true)
      useOnboardingStore.getState().setJobPhase('chat', 'done')
    })

    expect(
      screen.getByRole('heading', { name: 'onboarding-wait:readyTitle' })
    ).toBeInTheDocument()
    expect(
      screen.getByText('onboarding-wait:readyOnDevice')
    ).toBeInTheDocument()
    expect(
      screen.queryByLabelText('onboarding-wait:email.label')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'onboarding-wait:hideGame' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('group', { name: 'onboarding-wait:mines.board' })
    ).toBeInTheDocument()

    click(/onboarding-wait:startChatting/)

    expect(useOnboardingStore.getState().phase).toBe('handedOff')
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/',
        search: {
          threadModel: { id: QWEN.modelId, provider: QWEN.provider },
        },
      })
    )
    expect(named('onboarding_step_left')[0]).toMatchObject({
      step: 'wait',
      step_action: 'start_chatting',
    })
  })
})
