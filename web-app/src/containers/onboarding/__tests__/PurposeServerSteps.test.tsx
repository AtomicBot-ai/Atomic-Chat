import '@/test/telemetry-ready'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import posthog from 'posthog-js'

import { localStorageKey } from '@/constants/localStorage'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServerSetup } from '@/hooks/useServerSetup'
import type { StepContext } from '@/lib/onboarding/steps'
import {
  useOnboardingStore,
  type OnboardingChoice,
} from '@/stores/onboarding-store'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  setServerRunning: vi.fn(),
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
vi.mock('../useStepContext', () => ({
  useStepContext: () => mocks.context,
}))
// Stopping the server is the core's; the stand-in moves the app state as the
// real helper does.
vi.mock('@/utils/localApiServerControl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/localApiServerControl')>()),
  setLocalApiServerRunning: mocks.setServerRunning,
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

/** A local engine as the provider store holds it; `persist` marks it local. */
const engine = (
  provider: string,
  models: string[],
  overrides: Partial<ModelProvider> = {}
) =>
  ({
    provider,
    active: true,
    persist: true,
    settings: [],
    models: models.map((id) => ({ id })),
    ...overrides,
  }) as unknown as ModelProvider

const QWEN: OnboardingChoice = {
  source: 'download',
  provider: 'llamacpp-upstream',
  modelId: 'Qwen3.5-4B-Q4_K_M',
  title: 'Qwen3.5 4B',
  matchIds: ['Qwen3.5-4B-Q4_K_M'],
}

const startAt = (
  step: 'purpose' | 'server',
  choice: OnboardingChoice | null
) => {
  const store = useOnboardingStore.getState()
  store.begin('full', step)
  store.choose(choice)
}

describe('purpose and server steps', () => {
  beforeEach(() => {
    vi.mocked(posthog.capture).mockClear()
    mocks.navigate.mockClear()
    mocks.setServerRunning.mockReset()
    mocks.setServerRunning.mockImplementation(async (running: boolean) =>
      useAppState.getState().setServerStatus(running ? 'running' : 'stopped')
    )
    localStorage.clear()
    useOnboardingStore.getState().reset()
    useAppState.setState({ serverStatus: 'stopped', activeModels: [] })
    useServerSetup.setState({
      setupDone: false,
      setupDismissed: false,
      endpointConfigured: false,
      guide: null,
      guideActive: false,
    })
    useModelProvider.setState({
      providers: [engine('llamacpp-upstream', [])],
    } as never)
  })

  it('counts purpose as the last step, with both ways to use the app', () => {
    startAt('purpose', QWEN)
    render(<Onboarding />)

    expect(
      screen.getByRole('heading', { name: 'onboarding-server:purpose.title' })
    ).toHaveFocus()
    expect(screen.getByText('onboarding:stepOf 03 03')).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: /onboarding-server:purpose\.everyday/,
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /onboarding-server:purpose\.power/ })
    ).toBeInTheDocument()
  })

  it('opens the workspace for everyday use, leaving the server alone', () => {
    startAt('purpose', QWEN)
    render(<Onboarding />)

    click(/onboarding-server:purpose\.everyday/)

    expect(useOnboardingStore.getState()).toMatchObject({
      phase: 'handedOff',
      destination: 'chat',
      guide: null,
    })
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/', replace: true })
    )
    expect(localStorage.getItem(localStorageKey.setupCompleted)).toBe('true')
    expect(named('onboarding_purpose')).toEqual([
      expect.objectContaining({ purpose: 'everyday' }),
    ])
    expect(named('onboarding_step_left')[0]).toMatchObject({
      step: 'purpose',
      step_action: 'everyday',
    })
    expect(useServerSetup.getState().setupDismissed).toBe(false)
  })

  it('goes on to the server step to power other tools, under the same counter, and back', () => {
    startAt('purpose', QWEN)
    render(<Onboarding />)

    click(/onboarding-server:purpose\.power/)

    expect(
      screen.getByRole('heading', { name: 'onboarding-server:server.title' })
    ).toHaveFocus()
    expect(screen.getByText('onboarding:stepOf 03 03')).toBeInTheDocument()
    expect(useOnboardingStore.getState().phase).toBe('active')
    expect(named('onboarding_purpose')).toEqual([
      expect.objectContaining({ purpose: 'power_tools' }),
    ])
    expect(named('onboarding_step_left')[0]).toMatchObject({
      step: 'purpose',
      step_action: 'power_tools',
    })

    click(/onboarding:back/)

    expect(useOnboardingStore.getState().step).toBe('purpose')
  })

  it('offers an endpoint or an agent for a model the server can run, even before it has downloaded', () => {
    startAt('server', QWEN)
    render(<Onboarding />)

    expect(
      screen.getByRole('button', { name: /onboarding-server:server\.endpoint/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /onboarding-server:server\.agents/ })
    ).toBeInTheDocument()
    expect(
      screen.queryByText('onboarding-server:server.incompatibleTitle')
    ).not.toBeInTheDocument()
  })

  it('sends a cloud model back to the model step for a local one', () => {
    useModelProvider.setState({
      providers: [
        engine('llamacpp-upstream', []),
        engine('openai', ['gpt-4.1'], { persist: false }),
      ],
    } as never)
    startAt('server', {
      source: 'library',
      provider: 'openai',
      modelId: 'gpt-4.1',
      title: 'GPT-4.1',
      matchIds: ['gpt-4.1'],
    })
    render(<Onboarding />)

    expect(
      screen.getByRole('heading', {
        name: 'onboarding-server:server.incompatibleTitle',
      })
    ).toBeInTheDocument()
    expect(
      screen.getByText('onboarding-server:server.incompatibleModel GPT-4.1')
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: /onboarding-server:server\.endpoint/,
      })
    ).not.toBeInTheDocument()

    click(/onboarding-server:server\.chooseModel/)

    expect(screen.getByRole('heading', { name: 'model step' })).toBeVisible()
    expect(useOnboardingStore.getState().step).toBe('model')
    expect(named('onboarding_step_left').at(-1)).toMatchObject({
      step: 'server',
      step_action: 'choose_local_model',
    })
  })

  it('asks for a local model when none was chosen, or its engine is switched off', () => {
    startAt('server', null)
    const { unmount } = render(<Onboarding />)

    expect(
      screen.getByText('onboarding-server:server.incompatibleNone')
    ).toBeInTheDocument()
    unmount()

    useModelProvider.setState({
      providers: [engine('llamacpp-upstream', [], { active: false })],
    } as never)
    useOnboardingStore.getState().choose(QWEN)
    render(<Onboarding />)

    expect(
      screen.getByText('onboarding-server:server.incompatibleModel Qwen3.5 4B')
    ).toBeInTheDocument()
  })

  it('hands off to the endpoint settings without starting the server', () => {
    startAt('server', QWEN)
    render(<Onboarding />)

    click(/onboarding-server:server\.endpoint/)

    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/settings/local-api-server',
      replace: true,
      search: {},
    })
    expect(useOnboardingStore.getState()).toMatchObject({
      phase: 'handedOff',
      destination: 'endpoint',
      guide: { path: 'endpoint', hint: 0 },
    })
    expect(useAppState.getState().serverStatus).toBe('stopped')
    // The hints stand in for the first-visit guide on Overview, and the
    // endpoint counts as set up: Start starts the server, hints or not.
    expect(useServerSetup.getState()).toMatchObject({
      setupDismissed: true,
      guideActive: false,
      setupDone: true,
      endpointConfigured: true,
    })
    expect(named('onboarding_completed')[0]).toMatchObject({
      destination: 'endpoint',
      step_reached: 'server',
    })
    expect(named('onboarding_step_left').at(-1)).toMatchObject({
      step: 'server',
      step_action: 'configure_endpoint',
    })
  })

  it('stops the server the launch started with nothing loaded, so Start loads the model', async () => {
    useAppState.setState({ serverStatus: 'running', activeModels: [] })
    startAt('server', QWEN)
    render(<Onboarding />)

    click(/onboarding-server:server\.endpoint/)

    // Only the listener: a turn-off would unload models, and there are none.
    expect(mocks.setServerRunning).toHaveBeenCalledWith(false)
    await waitFor(() =>
      expect(useAppState.getState().serverStatus).toBe('stopped')
    )
  })

  it('leaves a server that serves a model running', () => {
    useAppState.setState({
      serverStatus: 'running',
      activeModels: ['Qwen3.5-4B-Q4_K_M'],
    })
    startAt('server', QWEN)
    render(<Onboarding />)

    click(/onboarding-server:server\.endpoint/)

    expect(mocks.setServerRunning).not.toHaveBeenCalled()
    expect(useAppState.getState().serverStatus).toBe('running')
  })

  it('hands off to the agents with the first-visit guide out of the way', () => {
    startAt('server', QWEN)
    render(<Onboarding />)

    click(/onboarding-server:server\.agents/)

    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/api/' })
    )
    expect(useOnboardingStore.getState().guide).toEqual({
      path: 'agents',
      hint: 0,
    })
    expect(useServerSetup.getState()).toMatchObject({
      setupDismissed: true,
      // The setup guide is still how an agent is set up.
      setupDone: false,
      endpointConfigured: false,
    })
    expect(useAppState.getState().serverStatus).toBe('stopped')
    expect(named('onboarding_step_left').at(-1)).toMatchObject({
      step_action: 'connect_agent',
    })
  })

  it('leaves a running server alone on the agents path: Configure & start loads the model', () => {
    useAppState.setState({ serverStatus: 'running', activeModels: [] })
    startAt('server', QWEN)
    render(<Onboarding />)

    click(/onboarding-server:server\.agents/)

    expect(mocks.setServerRunning).not.toHaveBeenCalled()
    expect(useAppState.getState().serverStatus).toBe('running')
  })
})
