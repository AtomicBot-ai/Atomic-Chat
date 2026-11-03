import '@/test/telemetry-ready'
/**
 * The GPU backend step with the real `SetupBackendStep` inside it. The old
 * first-run screen's suite only ever reached this card on a Windows run it
 * never made; the flow's own test replaces it with a button. Detection and
 * the download machine are faked at their seams (the llama.cpp extension and
 * `useBackendUpdater`), so what is under test is the card's own decisions.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import posthog from 'posthog-js'

import { localStorageKey } from '@/constants/localStorage'
import type { RecommendationPhase } from '@/hooks/useBackendUpdater'

type Recheck = {
  currentBackend: string
  recommendedBackend: string
  recommendedCategory: string
} | null

const mocks = vi.hoisted(() => ({
  extension: null as {
    recheckOptimalBackend: () => Promise<unknown>
    getLastRecheckOutcome?: () => string | null
  } | null,
  updater: {
    recommendation: null as {
      recommendedBackend: string
      recommendedCategory: string
    } | null,
    recommendationPhase: 'idle' as string,
    downloadState: { backendName: null as string | null },
    downloadRecommendedBackend: vi.fn(async () => {}),
  },
}))

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn() },
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key} ${Object.values(vars).join(' ')}` : key,
  }),
}))
vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({
      getByName: () => mocks.extension ?? undefined,
      listExtensions: () => [],
    }),
  },
}))
vi.mock('@/hooks/useBackendUpdater', () => ({
  useBackendUpdater: () => ({ ...mocks.updater }),
}))

import { BackendStep } from '../steps/BackendStep'

const vulkan = {
  currentBackend: 'win-cpu-x64',
  recommendedBackend: 'win-vulkan-x64',
  recommendedCategory: 'Vulkan',
}

/** The machine has a better build to offer, or (`null`) has none. */
function detect(result: Recheck, outcome: string | null = null) {
  mocks.extension = {
    recheckOptimalBackend: vi.fn(async () => result),
    getLastRecheckOutcome: () => outcome,
  }
  mocks.updater.recommendation = result
    ? {
        recommendedBackend: result.recommendedBackend,
        recommendedCategory: result.recommendedCategory,
      }
    : null
  mocks.updater.recommendationPhase = result ? 'recommend' : 'idle'
}

const resolved = () =>
  vi
    .mocked(posthog.capture)
    .mock.calls.filter(([name]) => name === 'backend_step_resolved')
    .map(([, props]) => props as Record<string, unknown>)

describe('GPU backend step', () => {
  const next = vi.fn()
  const goTo = vi.fn()
  const handOff = vi.fn()
  const step = () => <BackendStep next={next} goTo={goTo} handOff={handOff} />

  /** The download machine moves on, as `useBackendUpdater` reports it. */
  const advance = (
    rerender: (ui: React.ReactElement) => void,
    phase: RecommendationPhase
  ) => {
    mocks.updater.recommendationPhase = phase
    rerender(step())
  }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.extension = null
    mocks.updater.recommendation = null
    mocks.updater.recommendationPhase = 'idle'
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('offers the faster build inside the step, and stays on CPU when declined', async () => {
    detect(vulkan)
    localStorage.setItem('llama_cpp_better_backend_recommendation', '{}')
    render(step())

    expect(
      await screen.findByText('setup:backendStep.recommendTitle Vulkan')
    ).toBeInTheDocument()
    // The flow draws the page; the card brings no title or logo of its own.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.queryByText('Atomic Chat')).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: /setup:backendStep.stayOnCpu/ })
    )

    expect(next).toHaveBeenCalledWith('backend_skipped')
    expect(localStorage.getItem(localStorageKey.llamacppOnboardingDone)).toBe(
      'skipped'
    )
    // Otherwise the dialog after setup offers the build the user declined.
    expect(
      localStorage.getItem('llama_cpp_better_backend_recommendation')
    ).toBeNull()
    expect(resolved()).toEqual([
      expect.objectContaining({
        step_status: 'cpu',
        recommended_category: 'Vulkan',
        current_backend: 'win-cpu-x64',
      }),
    ])
  })

  it('moves on by itself when this machine has nothing better to install', async () => {
    detect(null, 'already_optimal')
    render(step())

    await waitFor(() => expect(next).toHaveBeenCalledWith('backend_skipped'))
    expect(localStorage.getItem(localStorageKey.llamacppOnboardingDone)).toBe(
      'skipped'
    )
    expect(resolved()).toEqual([
      expect.objectContaining({
        step_status: 'no_recommendation',
        no_recommendation_reason: 'already_optimal',
      }),
    ])
  })

  it('moves on when there is no llama.cpp extension to ask', async () => {
    render(step())

    await waitFor(() => expect(next).toHaveBeenCalledWith('backend_skipped'))
    expect(resolved()).toEqual([
      expect.objectContaining({
        step_status: 'detection_failed',
        detection_failure_reason: 'no_extension',
      }),
    ])
  })

  it('never keeps the user on the spinner past the watchdog', async () => {
    vi.useFakeTimers()
    mocks.extension = {
      recheckOptimalBackend: () => new Promise(() => {}),
    }
    render(step())
    expect(screen.getByText('setup:backendStep.detecting')).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })

    expect(next).toHaveBeenCalledWith('backend_skipped')
    expect(resolved()).toEqual([
      expect.objectContaining({
        step_status: 'detection_failed',
        detection_failure_reason: 'watchdog',
      }),
    ])
  })

  it('downloads the build and goes on once it is switched in without a restart', async () => {
    detect(vulkan)
    const { rerender } = render(step())
    fireEvent.click(
      await screen.findByRole('button', {
        name: /setup:backendStep.downloadAction/,
      })
    )
    expect(mocks.updater.downloadRecommendedBackend.mock.calls).toHaveLength(1)

    advance(rerender, 'downloading')
    expect(
      screen.getByText('setup:backendStep.downloadingTitle')
    ).toBeInTheDocument()
    advance(rerender, 'hotswapping')
    expect(
      screen.getByText('setup:backendStep.switchingTitle')
    ).toBeInTheDocument()
    expect(next).not.toHaveBeenCalled()

    advance(rerender, 'completed')

    expect(next).toHaveBeenCalledWith('backend_downloaded')
    expect(localStorage.getItem(localStorageKey.llamacppOnboardingDone)).toBe(
      'downloaded'
    )
    expect(resolved()).toEqual([
      expect.objectContaining({ step_status: 'downloaded' }),
    ])
  })

  it('writes the outcome down before a restart, which ends the process', async () => {
    const relaunch = vi.fn(() => new Promise<void>(() => {}))
    vi.stubGlobal('core', { api: { relaunch } })
    try {
      detect(vulkan)
      const { rerender } = render(step())
      fireEvent.click(
        await screen.findByRole('button', {
          name: /setup:backendStep.downloadAction/,
        })
      )
      advance(rerender, 'restart-required')

      fireEvent.click(
        screen.getByRole('button', { name: /setup:backendStep.restartNow/ })
      )

      // The relaunch kills the process before the step can resolve, so the
      // flag that keeps the step from coming back, and the outcome the next
      // launch reports, are both written first.
      expect(relaunch.mock.calls).toHaveLength(1)
      expect(localStorage.getItem(localStorageKey.llamacppOnboardingDone)).toBe(
        'downloaded'
      )
      expect(
        JSON.parse(
          localStorage.getItem(localStorageKey.backendStepRestartIntent)!
        )
      ).toMatchObject({
        step_status: 'downloaded',
        recommended_category: 'Vulkan',
      })
      expect(next).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('goes on to the model when the relaunch fails, and reports it only now', async () => {
    vi.stubGlobal('core', {
      api: {
        relaunch: vi.fn(async () => {
          throw new Error('relaunch IPC failed')
        }),
      },
    })
    try {
      detect(vulkan)
      const { rerender } = render(step())
      fireEvent.click(
        await screen.findByRole('button', {
          name: /setup:backendStep.downloadAction/,
        })
      )
      advance(rerender, 'restart-required')

      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /setup:backendStep.restartNow/ })
        )
      })

      // The process survived, so the outcome is reported here and the
      // record meant for the next launch is dropped: it would count twice.
      expect(next).toHaveBeenCalledWith('backend_downloaded')
      expect(
        localStorage.getItem(localStorageKey.backendStepRestartIntent)
      ).toBeNull()
      expect(resolved()).toEqual([
        expect.objectContaining({ step_status: 'downloaded' }),
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('offers the build again when its download fails', async () => {
    detect(vulkan)
    mocks.updater.downloadRecommendedBackend.mockRejectedValueOnce(
      new Error('network down')
    )
    render(step())
    const download = await screen.findByRole('button', {
      name: /setup:backendStep.downloadAction/,
    })

    await act(async () => {
      fireEvent.click(download)
    })

    expect(
      screen.getByRole('button', { name: /setup:backendStep.downloadAction/ })
    ).toBeEnabled()
    expect(
      screen.getByRole('button', { name: /setup:backendStep.stayOnCpu/ })
    ).toBeInTheDocument()
    expect(next).not.toHaveBeenCalled()
    expect(
      localStorage.getItem(localStorageKey.llamacppOnboardingDone)
    ).toBeNull()
  })

  it('goes on to the model when the user restarts later', async () => {
    detect(vulkan)
    const { rerender } = render(step())
    fireEvent.click(
      await screen.findByRole('button', {
        name: /setup:backendStep.downloadAction/,
      })
    )
    advance(rerender, 'restart-required')

    fireEvent.click(
      screen.getByRole('button', { name: 'setup:backendStep.restartLater' })
    )

    expect(next).toHaveBeenCalledWith('backend_downloaded')
    expect(localStorage.getItem(localStorageKey.llamacppOnboardingDone)).toBe(
      'downloaded'
    )
  })
})
