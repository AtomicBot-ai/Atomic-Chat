/**
 * What the old first-run screen's suite proved about leaving setup that the
 * full-window flow still has to: nothing walks the user out on a timer, a
 * model landing mid-run does not either, and Skip setup leaves exactly once,
 * into an empty chat.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { localStorageKey } from '@/constants/localStorage'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useModelLoad } from '@/hooks/useModelLoad'
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
  useStepContext: () => mocks.context,
}))
// The model list has screens and tests of its own (ModelStep tests).
vi.mock('../steps/ModelStep', () => ({
  ModelStep: () => <h1 tabIndex={-1}>model step</h1>,
}))

import { Onboarding } from '../Onboarding'
import { OnboardingRuntime } from '../OnboardingRuntime'

const qwen = {
  source: 'download' as const,
  provider: 'llamacpp-upstream',
  modelId: 'Qwen3.5-4B-Q4_K_M',
  title: 'Qwen3.5 4B',
  matchIds: ['Qwen3.5-4B-Q4_K_M'],
}

describe('leaving the first-run flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useOnboardingStore.getState().reset()
    useModelProvider.setState({
      providers: [],
      selectedProvider: 'llamacpp-upstream',
      selectedModel: null,
    } as never)
    useModelLoad.setState({ modelSelectionDeferred: false })
    useLeftPanel.getState().setLeftPanel(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('never leaves on its own, however long the user stays', async () => {
    // The replaced screen walked users out empty-handed on a 15-second
    // timer — 60 % of all exits, at a 16.2 s median — and later re-armed it
    // whenever a dialog closed. A download or an import in flight must not
    // be cut short either.
    vi.useFakeTimers()
    const store = useOnboardingStore.getState()
    store.begin('full', 'model')
    store.choose(qwen)
    store.enqueue({
      key: 'chat',
      kind: 'chat',
      title: 'Qwen3.5 4B',
      taskId: 'Qwen3.5-4B-Q4_K_M',
      phase: 'running',
    })
    render(<Onboarding />)

    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000)
    })

    expect(screen.getByRole('heading', { name: 'model step' })).toBeVisible()
    expect(useOnboardingStore.getState().phase).toBe('active')
    expect(localStorage.getItem(localStorageKey.setupCompleted)).toBeNull()
    expect(mocks.navigate.mock.calls).toEqual([])
  })

  it('stays in setup when the chosen model lands in the library mid-run', () => {
    // The old screen handed off on the click and had to ignore the later
    // import; the run now carries on through its steps and only marks the
    // download done. The runtime that marks it is mounted beside the screen,
    // as in the app.
    const store = useOnboardingStore.getState()
    store.begin('full', 'model')
    store.choose(qwen)
    store.enqueue({
      key: 'chat',
      kind: 'chat',
      title: 'Qwen3.5 4B',
      taskId: 'Qwen3.5-4B-Q4_K_M',
      phase: 'running',
    })
    render(
      <>
        <Onboarding />
        <OnboardingRuntime />
      </>
    )

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
    })

    expect(useOnboardingStore.getState()).toMatchObject({
      phase: 'active',
      step: 'model',
      jobs: [{ key: 'chat', phase: 'done' }],
    })
    expect(localStorage.getItem(localStorageKey.setupCompleted)).toBeNull()
    expect(mocks.navigate.mock.calls).toEqual([])
  })

  it('leaves through Skip setup only when it is pressed, into an empty chat, once', () => {
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({ provider: 'llamacpp-upstream', model: 'stale.gguf' })
    )
    render(<Onboarding />)
    const skip = screen.getByTestId('onboarding-skip')
    expect(localStorage.getItem(localStorageKey.setupCompleted)).toBeNull()
    expect(mocks.navigate.mock.calls).toEqual([])

    fireEvent.click(skip)

    // The composer's widget takes over from here, which is what makes
    // leaving empty-handed a defensible thing to offer at all.
    expect(localStorage.getItem(localStorageKey.setupCompleted)).toBe('true')
    expect(localStorage.getItem(localStorageKey.lastUsedModel)).toBeNull()
    expect(useModelProvider.getState().selectedProvider).toBe('')
    expect(useModelLoad.getState().modelSelectionDeferred).toBe(true)
    expect(useLeftPanel.getState().open).toBe(true)
    expect(mocks.navigate.mock.calls).toEqual([
      [{ to: '/', replace: true, search: {} }],
    ])
  })
})
