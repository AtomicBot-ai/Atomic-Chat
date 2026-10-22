import { beforeEach, describe, expect, it, vi } from 'vitest'
import posthog from 'posthog-js'

import { localStorageKey } from '@/constants/localStorage'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useModelProvider } from '@/hooks/useModelProvider'
import { isOnboardingPending, resetForcedOnboardingRun } from '@/lib/onboarding'
import { useOnboardingStore } from '@/stores/onboarding-store'

import { exitPathOf, handOffOnboarding } from '../handoff'

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), has_opted_in_capturing: () => true },
}))

const events = () =>
  vi
    .mocked(posthog.capture)
    .mock.calls.map(
      ([name, props]) => [name, props] as [string, Record<string, unknown>]
    )
const completed = () =>
  events().filter(([name]) => name === 'onboarding_completed')

const qwen = {
  source: 'download' as const,
  provider: 'llamacpp-upstream',
  modelId: 'Qwen3.5-4B-Q4_K_M',
  title: 'Qwen3.5 4B',
  matchIds: ['Qwen3.5-4B-Q4_K_M'],
}
const chatJob = {
  key: 'chat',
  kind: 'chat' as const,
  title: 'Qwen3.5 4B',
  taskId: 'Qwen3.5-4B-Q4_K_M',
  phase: 'running' as const,
}

describe('leaving the setup screen', () => {
  const navigate = vi.fn()

  beforeEach(() => {
    vi.mocked(posthog.capture).mockClear()
    navigate.mockClear()
    localStorage.clear()
    useOnboardingStore.getState().reset()
    useOnboardingStore.getState().begin('full', 'welcome')
    useModelProvider.setState({
      providers: [],
      selectedProvider: 'llamacpp-upstream',
      selectedModel: null,
    } as never)
    useModelLoad.setState({ modelSelectionDeferred: false })
    useLeftPanel.getState().setLeftPanel(false)
  })

  it('opens the chat on a model that can already answer', () => {
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [{ id: 'Qwen3.5-4B-Q4_K_M' }],
        },
      ],
    } as never)
    useOnboardingStore.getState().choose({ ...qwen, source: 'scan' })

    handOffOnboarding({ destination: 'chat', stepReached: 'model', navigate })

    expect(useModelProvider.getState().selectedProvider).toBe(
      'llamacpp-upstream'
    )
    expect(
      JSON.parse(localStorage.getItem(localStorageKey.lastUsedModel)!)
    ).toEqual({ provider: 'llamacpp-upstream', model: 'Qwen3.5-4B-Q4_K_M' })
    expect(navigate).toHaveBeenCalledWith({
      to: '/',
      replace: true,
      search: {
        threadModel: { id: 'Qwen3.5-4B-Q4_K_M', provider: 'llamacpp-upstream' },
      },
    })
    expect(completed()[0][1]).toMatchObject({
      exit_path: 'imported',
      step_reached: 'model',
      onboarding_variant: 'full',
      destination: 'chat',
    })
  })

  it('leaves a running download to finish and completes setup', () => {
    useOnboardingStore.getState().choose(qwen)
    useOnboardingStore.getState().enqueue(chatJob)

    handOffOnboarding({ destination: 'chat', stepReached: 'model', navigate })

    expect(localStorage.getItem(localStorageKey.setupCompleted)).toBe('true')
    expect(useOnboardingStore.getState()).toMatchObject({
      phase: 'handedOff',
      destination: 'chat',
    })
    expect(useLeftPanel.getState().open).toBe(true)
    expect(navigate.mock.calls[0][0].search).toEqual({})
    expect(completed()[0][1].exit_path).toBe('download_started')
  })

  it('leaves empty-handed without a model preselected behind the user', () => {
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({ provider: 'llamacpp', model: 'stale' })
    )

    handOffOnboarding({ destination: 'chat', stepReached: 'welcome', navigate })

    expect(useModelLoad.getState().modelSelectionDeferred).toBe(true)
    expect(useModelProvider.getState().selectedProvider).toBe('')
    expect(localStorage.getItem(localStorageKey.lastUsedModel)).toBeNull()
    expect(events().map(([name]) => name)).toEqual([
      'setup_skipped',
      'onboarding_completed',
    ])
    expect(completed()[0][1]).toMatchObject({
      exit_path: 'dismissed',
      step_reached: 'welcome',
    })
  })

  it('ends a forced re-run over an installed model without selecting it', () => {
    // A `FORCE_ONBOARDING` build replays setup for a returning user: a model
    // is installed and was the last one used. Leaving empty-handed must not
    // hand it back behind the user, nor start or remove anything.
    vi.stubGlobal('FORCE_ONBOARDING', true)
    try {
      const installed = {
        provider: 'llamacpp-upstream',
        active: true,
        models: [{ id: 'installed.gguf' }],
      }
      useModelProvider.setState({
        providers: [installed],
        selectedProvider: 'llamacpp-upstream',
        selectedModel: { id: 'installed.gguf' },
      } as never)
      localStorage.setItem(localStorageKey.setupCompleted, 'true')
      localStorage.setItem(
        localStorageKey.lastUsedModel,
        JSON.stringify({
          provider: 'llamacpp-upstream',
          model: 'installed.gguf',
        })
      )
      resetForcedOnboardingRun()
      useOnboardingStore.getState().begin('full', 'welcome')
      expect(isOnboardingPending([installed])).toBe(true)

      handOffOnboarding({
        destination: 'chat',
        stepReached: 'welcome',
        navigate,
      })

      expect(useModelProvider.getState()).toMatchObject({
        providers: [installed],
        selectedProvider: '',
        selectedModel: null,
      })
      expect(localStorage.getItem(localStorageKey.lastUsedModel)).toBeNull()
      expect(useModelLoad.getState().modelSelectionDeferred).toBe(true)
      expect(localStorage.getItem(localStorageKey.setupCompleted)).toBe('true')
      expect(isOnboardingPending([installed])).toBe(false)
      expect(navigate.mock.calls).toEqual([
        [{ to: '/', replace: true, search: {} }],
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports completion once, even after "Back to setup"', () => {
    handOffOnboarding({ destination: 'chat', stepReached: 'model', navigate })
    useOnboardingStore.getState().reopen()
    handOffOnboarding({ destination: 'chat', stepReached: 'model', navigate })

    expect(completed()).toHaveLength(1)
    expect(navigate).toHaveBeenCalledTimes(2)
  })

  it('opens the server pages with their first hint on a server handoff', () => {
    useOnboardingStore.getState().choose(qwen)

    handOffOnboarding({
      destination: 'endpoint',
      stepReached: 'server',
      navigate,
    })

    expect(navigate.mock.calls[0][0]).toEqual({
      to: '/settings/local-api-server',
      replace: true,
      search: {},
    })
    expect(useOnboardingStore.getState().guide).toEqual({
      path: 'endpoint',
      hint: 0,
    })
  })

  it('names how the run ended', () => {
    expect(exitPathOf({ choice: null, jobs: [] })).toBe('dismissed')
    expect(exitPathOf({ choice: qwen, jobs: [chatJob] })).toBe(
      'download_started'
    )
    expect(
      exitPathOf({ choice: { ...qwen, source: 'library' }, jobs: [] })
    ).toBe('imported')
  })
})
