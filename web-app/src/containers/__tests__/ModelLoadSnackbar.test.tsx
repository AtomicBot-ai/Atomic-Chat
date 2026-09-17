import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppState } from '@/hooks/useAppState'
import { useInferenceStatus } from '@/hooks/useInferenceStatus'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useModelProvider } from '@/hooks/useModelProvider'
import i18n from '@/i18n/setup'
import { modelLoadStageKey } from '@/lib/inference-status'
import { ToasterProvider } from '@/providers/ToasterProvider'
import { modelLoadStages } from '@/test/model-load-stages'
import { cancelModelLoad } from '@/utils/switchModel'
import { LOADED_SNACKBAR_MS, ModelLoadSnackbar } from '../ModelLoadSnackbar'

vi.mock('@/utils/switchModel', () => ({
  cancelModelLoad: vi.fn(),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({}),
}))

const MODEL = 'Qwen3-8B'

const seed = (
  app: Partial<ReturnType<typeof useAppState.getState>>,
  provider = 'llamacpp'
) => {
  act(() => {
    useAppState.setState(app)
    useModelProvider.setState({
      selectedProvider: provider,
      selectedModel: { id: MODEL } as never,
    })
  })
}

const startLoad = (kind: 'start' | 'restart' = 'start', modelId = MODEL) =>
  act(() => useAppState.getState().updateLoadingModel(true, { modelId, kind }))

const finishLoad = () =>
  act(() => {
    useAppState.setState({ activeModels: [MODEL] })
    useAppState.getState().updateLoadingModel(false)
  })

const snackbar = () => screen.queryByTestId('model-load-snackbar')

const renderSnackbar = () =>
  render(
    <>
      <ToasterProvider />
      <ModelLoadSnackbar />
    </>
  )

describe('ModelLoadSnackbar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    i18n.changeLanguage('en')
    vi.mocked(cancelModelLoad).mockImplementation(async () => {
      useAppState.getState().setLoadingModelCancelling(true)
    })
    act(() => {
      useModelLoad.setState({
        modelLoadError: undefined,
        modelLoadErrorModelId: undefined,
      })
      useAppState.setState({
        activeModels: [],
        userStoppedModels: [],
      })
      useAppState.getState().updateLoadingModel(false)
    })
    seed({})
  })

  afterEach(() => {
    vi.useRealTimers()
    document.documentElement.style.removeProperty('--font-size-base')
  })

  it.each([
    ['start', '18px'],
    ['start', '20px'],
    ['restart', '18px'],
    ['restart', '20px'],
  ] as const)(
    'shows concise cached %s copy at font size %s',
    async (kind, fontSize) => {
      document.documentElement.style.setProperty('--font-size-base', fontSize)
      renderSnackbar()
      startLoad(kind, 'org/' + 'VeryLongModelName'.repeat(20) + '-Q4_K_M.gguf')
      act(() =>
        useAppState.getState().setLoadingModelProgress({
          kind: 'loadingWeights',
          cachedFraction: 1,
        })
      )

      await waitFor(() =>
        expect(snackbar()).toHaveAttribute('data-face', 'loading')
      )
      expect(
        screen.getByText('Starting Model', { exact: true })
      ).toBeInTheDocument()
      expect(
        screen.getByText('Loading model into memory', { exact: true })
      ).toBeInTheDocument()

      expect(screen.getAllByRole('status')).toHaveLength(1)
      expect(snackbar()).toHaveTextContent(
        /^Starting ModelLoading model into memoryCancel$/
      )
      expect(snackbar()?.querySelectorAll('.animate-spin')).toHaveLength(1)
      expect(screen.getAllByRole('button')).toHaveLength(2)
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled()

      fireEvent.click(
        screen.getByRole('button', { name: 'Cancel', exact: true })
      )
      expect(
        await screen.findByRole('button', { name: 'Cancelling…' })
      ).toBeDisabled()
    }
  )

  describe.each(['start', 'restart'] as const)('%s stages', (kind) => {
    it.each(modelLoadStages)(
      'keeps stable visible copy and real diagnostic progress for $stage',
      async ({ stage, progress }) => {
        renderSnackbar()
        const { result } = renderHook(() => useInferenceStatus())
        startLoad(kind)
        act(() => useAppState.getState().setLoadingModelProgress(progress))

        await waitFor(() =>
          expect(snackbar()).toHaveAttribute('data-face', 'loading')
        )
        expect(
          screen.getByText('Starting Model', { exact: true })
        ).toBeInTheDocument()
        expect(
          screen.getByText('Loading model into memory', { exact: true })
        ).toBeInTheDocument()
        expect(snackbar()).toHaveTextContent(
          /^Starting ModelLoading model into memoryCancel$/
        )
        expect(snackbar()).toHaveAttribute('data-stage', progress.kind)
        expect(useAppState.getState().loadingModelProgress).toEqual(progress)
        expect(result.current).toMatchObject({
          phase: kind === 'start' ? 'starting' : 'restarting',
          progress,
        })
        expect(modelLoadStageKey(result.current.progress!)).toBe(stage)
      }
    )
  })

  it('stops offering Cancel twice once a cancel is under way', async () => {
    renderSnackbar()
    startLoad()
    act(() => useAppState.getState().setLoadingModelCancelling(true))

    expect(
      await screen.findByRole('button', { name: 'Cancelling…' })
    ).toBeDisabled()
  })

  it('turns into "loaded" when the model is up, then clears itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderSnackbar()
    startLoad()
    await waitFor(() => expect(snackbar()).toBeInTheDocument())

    finishLoad()

    await waitFor(() =>
      expect(snackbar()).toHaveAttribute('data-face', 'loaded')
    )
    expect(screen.getByText('Model ready', { exact: true })).toBeInTheDocument()
    expect(
      screen.getByText('Loaded into memory', { exact: true })
    ).toBeInTheDocument()
    expect(snackbar()).not.toHaveTextContent(MODEL)
    expect(
      screen.queryByRole('button', { name: 'Cancel' })
    ).not.toBeInTheDocument()
    expect(snackbar()?.querySelector('.animate-spin')).toBeNull()

    act(() => vi.advanceTimersByTime(LOADED_SNACKBAR_MS - 100))
    expect(snackbar()).toBeInTheDocument()

    // Cross the deadline and allow Sonner's exit animation to finish.
    act(() => vi.advanceTimersByTime(1100))
    await waitFor(() => expect(snackbar()).not.toBeInTheDocument())
  })

  it('dismisses the ready state and permits the next load', async () => {
    renderSnackbar()
    startLoad()
    await waitFor(() => expect(snackbar()).toBeInTheDocument())
    finishLoad()
    await screen.findByText('Model ready')

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(snackbar()).not.toBeInTheDocument())
    startLoad('restart')
    await waitFor(() =>
      expect(snackbar()).toHaveAttribute('data-face', 'loading')
    )
    expect(screen.getByText('Starting Model')).toBeInTheDocument()
  })

  it('stays closed for the rest of a load the user dismissed', async () => {
    renderSnackbar()
    startLoad()
    await waitFor(() => expect(snackbar()).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(snackbar()).not.toBeInTheDocument())

    act(() =>
      useAppState.getState().setLoadingModelProgress({ kind: 'startingServer' })
    )
    finishLoad()

    // Neither the next step nor the success brings it back.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(snackbar()).not.toBeInTheDocument()
  })

  it('goes away when the load ends without a model', async () => {
    renderSnackbar()
    startLoad()
    await waitFor(() => expect(snackbar()).toBeInTheDocument())

    // A failure (or a cancel) leaves nothing in memory; the failure has its
    // own toast and the strip above the composer.
    act(() => {
      useModelLoad.setState({
        modelLoadError: { message: 'boom' } as never,
        modelLoadErrorModelId: MODEL,
      })
      useAppState.getState().updateLoadingModel(false)
    })

    await waitFor(() => expect(snackbar()).not.toBeInTheDocument())
  })

  it('shows again for the next load after one was dismissed', async () => {
    renderSnackbar()
    startLoad()
    await waitFor(() => expect(snackbar()).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(snackbar()).not.toBeInTheDocument())
    act(() => useAppState.getState().updateLoadingModel(false))

    startLoad('restart')

    await waitFor(() => expect(snackbar()).toBeInTheDocument())
    expect(screen.getByText('Starting Model')).toBeInTheDocument()
  })

  it('says nothing about a remote provider', async () => {
    seed({}, 'openai')
    renderSnackbar()
    startLoad()

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(snackbar()).not.toBeInTheDocument()
  })
})
