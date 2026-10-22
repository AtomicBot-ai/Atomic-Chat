import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import posthog from 'posthog-js'

import { localStorageKey } from '@/constants/localStorage'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { StepContext } from '@/lib/onboarding/steps'
import { useOnboardingStore } from '@/stores/onboarding-store'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  context: {
    winOrLinux: false,
    backendStepDone: false,
    permissionRows: 0,
    cloudProviders: 0,
    mediaCards: 0,
    localApiServer: false,
  } as StepContext,
}))

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), has_opted_in_capturing: () => true },
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
  useStepContext: () => ({
    ...mocks.context,
    backendStepDone: Boolean(localStorage.getItem('llama_cpp_onboarding_done')),
  }),
}))
// The model list has screens and tests of its own (ModelStep.test).
vi.mock('../steps/ModelStep', () => ({
  ModelStep: ({ next }: { next: (action?: string) => void }) => (
    <>
      <h1 tabIndex={-1}>model step</h1>
      <button onClick={() => next('download')}>pick a model</button>
    </>
  ),
}))
// Detecting the GPU needs the llama.cpp extension; its outcomes are enough.
vi.mock('@/containers/SetupBackendStep', () => ({
  default: ({
    onDone,
  }: {
    onDone: (status: 'downloaded' | 'skipped') => void
  }) => <button onClick={() => onDone('skipped')}>stay on CPU</button>,
}))

import { Onboarding } from '../Onboarding'

const events = () =>
  vi
    .mocked(posthog.capture)
    .mock.calls.map(
      ([name, props]) => [name, props] as [string, Record<string, unknown>]
    )
const named = (event: string) =>
  events()
    .filter(([name]) => name === event)
    .map(([, props]) => props)

describe('first-run flow', () => {
  beforeEach(() => {
    vi.mocked(posthog.capture).mockClear()
    mocks.navigate.mockClear()
    mocks.context = { ...mocks.context, winOrLinux: false }
    localStorage.clear()
    useOnboardingStore.getState().reset()
    useModelProvider.setState({ providers: [] } as never)
  })

  it('starts a run on Welcome', () => {
    render(<Onboarding />)

    expect(
      screen.getByRole('heading', { name: 'onboarding:welcome.title' })
    ).toHaveFocus()
    expect(useOnboardingStore.getState()).toMatchObject({
      phase: 'active',
      variant: 'full',
      step: 'welcome',
    })
    expect(screen.queryByText(/onboarding:stepOf/)).not.toBeInTheDocument()
    expect(named('onboarding_step_shown')).toEqual([
      expect.objectContaining({
        step: 'welcome',
        step_index: 1,
        step_count: 2,
        onboarding_variant: 'full',
      }),
    ])
  })

  it('goes on to the model with its place counted, and back again', () => {
    render(<Onboarding />)

    fireEvent.click(screen.getByRole('button', { name: /welcome.start/ }))

    expect(screen.getByRole('heading', { name: 'model step' })).toHaveFocus()
    expect(screen.getByText('onboarding:stepOf 02 02')).toBeInTheDocument()
    expect(named('onboarding_step_left')[0]).toMatchObject({
      step: 'welcome',
      step_action: 'next',
    })

    fireEvent.click(screen.getByRole('button', { name: /onboarding:back/ }))

    expect(useOnboardingStore.getState().step).toBe('welcome')
    expect(named('onboarding_step_left')[1]).toMatchObject({
      step: 'model',
      step_action: 'back',
    })
  })

  it('hands off to the chat past the last step', () => {
    useOnboardingStore.getState().begin('full', 'model')
    render(<Onboarding />)

    fireEvent.click(screen.getByRole('button', { name: 'pick a model' }))

    expect(useOnboardingStore.getState().phase).toBe('handedOff')
    expect(localStorage.getItem(localStorageKey.setupCompleted)).toBe('true')
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/', replace: true })
    )
    expect(named('onboarding_step_left')[0]).toMatchObject({
      step: 'model',
      step_action: 'download',
    })
  })

  it('leaves from any step with Skip setup', () => {
    render(<Onboarding />)

    fireEvent.click(screen.getByTestId('onboarding-skip'))

    expect(useOnboardingStore.getState().phase).toBe('handedOff')
    expect(named('onboarding_completed')[0]).toMatchObject({
      exit_path: 'dismissed',
      step_reached: 'welcome',
    })
    expect(named('onboarding_step_left')[0].step_action).toBe('skip_setup')
  })

  describe('on Windows and Linux', () => {
    beforeEach(() => {
      mocks.context = { ...mocks.context, winOrLinux: true }
    })

    it('offers the GPU backend before the model, with its own way out', () => {
      useOnboardingStore.getState().begin('full', 'backend')
      render(<Onboarding />)

      expect(
        screen.getByRole('heading', { name: 'setup:backendStep.title' })
      ).toBeInTheDocument()
      expect(screen.queryByTestId('onboarding-skip')).not.toBeInTheDocument()
      expect(screen.queryByText(/onboarding:stepOf/)).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'stay on CPU' }))

      expect(localStorage.getItem(localStorageKey.llamacppOnboardingDone)).toBe(
        'skipped'
      )
      expect(screen.getByRole('heading', { name: 'model step' })).toBeVisible()
      expect(named('onboarding_step_left')[0]).toMatchObject({
        step: 'backend',
        step_action: 'backend_skipped',
      })
    })

    // A downloaded backend relaunches the app with the flag already set.
    it('resumes on the model after the relaunch', () => {
      useOnboardingStore.getState().begin('full', 'backend')
      localStorage.setItem(localStorageKey.llamacppOnboardingDone, 'downloaded')

      render(<Onboarding />)

      expect(screen.getByRole('heading', { name: 'model step' })).toBeVisible()
      expect(useOnboardingStore.getState().step).toBe('model')
    })
  })

  it('comes back to an active run after "Back to setup"', () => {
    useOnboardingStore.getState().begin('full', 'model')
    useOnboardingStore.getState().handOff('chat')

    render(<Onboarding />)

    expect(useOnboardingStore.getState().phase).toBe('active')
    expect(screen.getByRole('heading', { name: 'model step' })).toBeVisible()
  })

  // Marking the job done is `OnboardingRuntime`'s, on every route; the
  // screen only shows where the run stands.
  it('says the chat model is ready once the run has it', () => {
    const store = useOnboardingStore.getState()
    store.begin('full', 'model')
    store.choose({
      source: 'download',
      provider: 'llamacpp-upstream',
      modelId: 'Qwen3.5-4B-Q4_K_M',
      title: 'Qwen3.5 4B',
      matchIds: ['Qwen3.5-4B-Q4_K_M'],
    })
    store.enqueue({
      key: 'chat',
      kind: 'chat',
      title: 'Qwen3.5 4B',
      taskId: 'Qwen3.5-4B-Q4_K_M',
      phase: 'running',
    })
    render(<Onboarding />)

    expect(
      screen.getByRole('progressbar', {
        name: 'onboarding:download.progress Qwen3.5 4B',
      })
    ).toBeInTheDocument()

    act(() => {
      useModelProvider.setState({
        providers: [
          {
            provider: 'llamacpp-upstream',
            active: true,
            models: [{ id: 'Qwen3.5-4B-Q4_K_M' }],
          },
        ],
      } as never)
      useOnboardingStore.getState().setJobPhase('chat', 'done')
    })

    expect(
      screen.getByText('onboarding:download.ready Qwen3.5 4B')
    ).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })
})
