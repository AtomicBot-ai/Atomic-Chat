import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SetupBackendStep from '../SetupBackendStep'
import { localStorageKey } from '@/constants/localStorage'

const state = vi.hoisted(() => ({
  extension: null as unknown,
  extensions: [] as unknown[],
  recommendation: null as {
    currentBackend: string
    recommendedBackend: string
    recommendedCategory: string
  } | null,
  recommendationPhase: 'idle',
  downloadState: { backendName: null as string | null },
  download: vi.fn(),
  recheck: vi.fn(),
  done: vi.fn(),
  relaunch: vi.fn(),
}))

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({
      getByName: () => state.extension,
      listExtensions: () => state.extensions,
    }),
  },
}))
vi.mock('@/hooks/useBackendUpdater', () => ({
  useBackendUpdater: () => ({
    recommendation: state.recommendation,
    recommendationPhase: state.recommendationPhase,
    downloadState: state.downloadState,
    downloadRecommendedBackend: state.download,
  }),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { backend?: string }) =>
      values?.backend ? `${key}:${values.backend}` : key,
  }),
}))
vi.mock('../HeaderPage', () => ({ default: () => <header /> }))

const recommendation = {
  currentBackend: 'cpu',
  recommendedBackend: 'cuda-12.4',
  recommendedCategory: 'CUDA',
}

async function mount() {
  const view = render(<SetupBackendStep onDone={state.done} />)
  await act(async () => {})
  return view
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  localStorage.clear()
  state.recommendation = recommendation
  state.recommendationPhase = 'recommend'
  state.downloadState.backendName = null
  state.recheck.mockResolvedValue(recommendation)
  state.download.mockResolvedValue(undefined)
  state.relaunch.mockResolvedValue(undefined)
  state.extension = { recheckOptimalBackend: state.recheck }
  state.extensions = []
  window.core.api.relaunch = state.relaunch
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SetupBackendStep', () => {
  it.each(['setup:backendStep.stayOnCpu', 'setup:skip'])('allows %s and clears the stale recommendation', async (button) => {
    localStorage.setItem('llama_cpp_better_backend_recommendation', 'stale')
    const view = await mount()
    expect(screen.getByText('setup:backendStep.recommendTitle:CUDA')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: button }))
    expect(state.done.mock.calls).toEqual([['skipped']])
    expect(localStorage.getItem('llama_cpp_better_backend_recommendation')).toBeNull()
    view.unmount()
  })

  it('continues on a CPU-only machine', async () => {
    state.recheck.mockResolvedValue(null)
    state.extension = {
      recheckOptimalBackend: state.recheck,
      getLastRecheckOutcome: () => 'no_gpu',
    }
    state.recommendation = null
    const view = await mount()
    expect(state.done.mock.calls).toEqual([['skipped']])
    view.unmount()
  })

  it.each(['class-name', 'inference-type'])('finds a legacy extension by %s', async (lookup) => {
    class LlamacppLegacy { recheckOptimalBackend = state.recheck }
    class LegacyEngine {
      recheckOptimalBackend = state.recheck
      type() { return 'Inference' }
    }
    state.extension = null
    state.extensions = [{}, lookup === 'class-name' ? new LlamacppLegacy() : new LegacyEngine()]
    const view = await mount()
    expect(screen.getByRole('button', { name: 'setup:backendStep.downloadAction' })).toBeEnabled()
    expect(state.recheck).toHaveBeenCalledOnce()
    expect(state.done).not.toHaveBeenCalled()
    view.unmount()
  })

  it.each([null, {}])('continues when no usable extension exists (%j)', async (extension) => {
    state.extension = extension
    state.recommendation = null
    const view = await mount()
    expect(state.done.mock.calls).toEqual([['skipped']])
    view.unmount()
  })

  it('continues after failed hardware detection rather than trapping the user', async () => {
    state.recheck.mockRejectedValue(new Error('driver unavailable'))
    const view = await mount()
    expect(state.done.mock.calls).toEqual([['skipped']])
    view.unmount()
  })

  it('advances after a hung detection reaches the watchdog deadline', async () => {
    state.recheck.mockReturnValue(new Promise(() => {}))
    const view = await mount()
    expect(screen.getByText('setup:backendStep.detecting')).toBeInTheDocument()
    await act(async () => { vi.advanceTimersByTime(30_000) })
    expect(state.done.mock.calls).toEqual([['skipped']])
    view.unmount()
  })

  it('ignores detection that settles after the screen has unmounted', async () => {
    let complete!: (value: null) => void
    state.recheck.mockReturnValue(new Promise((resolve) => { complete = resolve }))
    const view = await mount()
    view.unmount()
    await act(async () => { complete(null) })
    expect(state.done.mock.calls).toEqual([])
  })

  it('ignores a detection rejection after the screen has unmounted', async () => {
    let fail!: (error: Error) => void
    state.recheck.mockReturnValue(new Promise((_resolve, reject) => { fail = reject }))
    const view = await mount()
    view.unmount()
    await act(async () => { fail(new Error('late driver failure')) })
    expect(state.done.mock.calls).toEqual([])
  })

  it('keeps a valid recommendation available after the detection watchdog expires', async () => {
    const view = await mount()
    await act(async () => { vi.advanceTimersByTime(30_000) })
    expect(screen.getByRole('button', { name: 'setup:backendStep.downloadAction' })).toBeEnabled()
    expect(state.done).not.toHaveBeenCalled()
    view.unmount()
  })

  it('shows download and switching progress, and completes a hot swap once', async () => {
    const view = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'setup:backendStep.downloadAction' }))
    expect(screen.getByText('setup:backendStep.downloadingTitle')).toBeInTheDocument()
    expect(state.download).toHaveBeenCalledOnce()
    state.recommendationPhase = 'downloading'
    view.rerender(<SetupBackendStep onDone={state.done} />)
    state.recommendationPhase = 'hotswapping'
    view.rerender(<SetupBackendStep onDone={state.done} />)
    expect(screen.getByText('setup:backendStep.switchingTitle')).toBeInTheDocument()
    state.recommendationPhase = 'completed'
    view.rerender(<SetupBackendStep onDone={state.done} />)
    expect(state.done.mock.calls).toEqual([['downloaded']])
    await act(async () => { vi.advanceTimersByTime(30_000) })
    view.unmount()
  })

  it('restores the recommendation after a failed download so it can be retried', async () => {
    state.download.mockRejectedValueOnce(new Error('network failed'))
    const view = await mount()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'setup:backendStep.downloadAction' }))
    })
    expect(screen.getByRole('button', { name: 'setup:backendStep.downloadAction' })).toBeEnabled()
    expect(state.done).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'setup:backendStep.downloadAction' }))
    expect(state.download).toHaveBeenCalledTimes(2)
    view.unmount()
  })

  it('returns to the recommendation when the updater reports a retryable failure', async () => {
    const view = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'setup:backendStep.downloadAction' }))
    state.recommendationPhase = 'downloading'
    view.rerender(<SetupBackendStep onDone={state.done} />)
    state.recommendationPhase = 'recommend'
    view.rerender(<SetupBackendStep onDone={state.done} />)
    expect(screen.getByRole('button', { name: 'setup:backendStep.downloadAction' })).toBeEnabled()
    expect(state.done).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'setup:backendStep.stayOnCpu' }))
    expect(state.done.mock.calls).toEqual([['skipped']])
    view.unmount()
  })

  it.each(['later', 'now', 'failed'])('handles restart choice %s with a durable onboarding outcome', async (choice) => {
    const view = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'setup:backendStep.downloadAction' }))
    state.recommendationPhase = 'restart-required'
    view.rerender(<SetupBackendStep onDone={state.done} />)
    expect(screen.getByText('setup:backendStep.restartTitle')).toBeInTheDocument()
    if (choice === 'failed') state.relaunch.mockRejectedValueOnce(new Error('IPC failed'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', {
        name: choice === 'later' ? 'setup:backendStep.restartLater' : 'setup:backendStep.restartNow',
      }))
    })
    if (choice === 'later') {
      expect(state.relaunch).not.toHaveBeenCalled()
      expect(state.done.mock.calls).toEqual([['downloaded']])
    } else {
      expect(localStorage.getItem(localStorageKey.llamacppOnboardingDone)).toBe('downloaded')
      expect(state.relaunch).toHaveBeenCalledOnce()
      expect(state.done.mock.calls).toEqual(choice === 'failed' ? [['downloaded']] : [])
    }
    view.unmount()
  })

  it('finishes once even when the user clicks twice', async () => {
    const view = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'setup:skip' }))
    fireEvent.click(screen.getByRole('button', { name: 'setup:skip' }))
    expect(state.done.mock.calls).toEqual([['skipped']])
    view.unmount()
  })

  it('still restarts when the onboarding flag cannot be persisted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const view = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'setup:backendStep.downloadAction' }))
    state.recommendationPhase = 'restart-required'
    view.rerender(<SetupBackendStep onDone={state.done} />)
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'setup:backendStep.restartNow' }))
    })
    expect(state.relaunch).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain('failed to persist onboarding flag')
    view.unmount()
  })
})
