import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Toaster } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppState } from '@/hooks/useAppState'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useModelProvider } from '@/hooks/useModelProvider'
import { cancelModelLoad } from '@/utils/switchModel'
import { LOADED_SNACKBAR_MS, ModelLoadSnackbar } from '../ModelLoadSnackbar'

vi.mock('@/i18n/setup', () => ({
  default: {
    t: (key: string, options?: Record<string, string>) =>
      options?.model ? `${key}:${options.model}` : key,
  },
}))

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

const startLoad = (kind: 'start' | 'restart' = 'start') =>
  act(() =>
    useAppState.getState().updateLoadingModel(true, { modelId: MODEL, kind })
  )

const finishLoad = () =>
  act(() => {
    useAppState.setState({ activeModels: [MODEL] })
    useAppState.getState().updateLoadingModel(false)
  })

const snackbar = () => screen.queryByTestId('model-load-snackbar')

const renderSnackbar = () =>
  render(
    <>
      <Toaster />
      <ModelLoadSnackbar />
    </>
  )

describe('ModelLoadSnackbar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
  })

  it('names the model, the step it is on, and offers a Cancel', async () => {
    renderSnackbar()
    startLoad()
    act(() =>
      useAppState
        .getState()
        .setLoadingModelProgress({ kind: 'loadingWeights', cachedFraction: 1 })
    )

    await waitFor(() =>
      expect(snackbar()).toHaveAttribute('data-face', 'loading')
    )
    expect(
      screen.getByText('common:inferenceStatus.starting:Qwen3 8B')
    ).toBeInTheDocument()
    expect(
      screen.getByText('common:modelLoad.stage.loadingCachedWeights')
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'common:modelLoad.cancel' })
    )
    expect(cancelModelLoad).toHaveBeenCalled()
  })

  it('tells a cold read off the disk apart from a load from cache', async () => {
    renderSnackbar()
    startLoad()
    act(() =>
      useAppState
        .getState()
        .setLoadingModelProgress({
          kind: 'loadingWeights',
          cachedFraction: 0.1,
        })
    )

    expect(
      await screen.findByText('common:modelLoad.stage.readingWeightsFromDisk')
    ).toBeInTheDocument()
  })

  it('stops offering Cancel twice once a cancel is under way', async () => {
    renderSnackbar()
    startLoad()
    act(() => useAppState.getState().setLoadingModelCancelling(true))

    expect(
      await screen.findByRole('button', { name: 'common:modelLoad.cancelling' })
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
    expect(
      screen.getByText('common:inferenceStatus.ready:Qwen3 8B')
    ).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(LOADED_SNACKBAR_MS + 1000))
    await waitFor(() => expect(snackbar()).not.toBeInTheDocument())
  })

  it('stays closed for the rest of a load the user dismissed', async () => {
    renderSnackbar()
    startLoad()
    await waitFor(() => expect(snackbar()).toBeInTheDocument())

    fireEvent.click(
      screen.getByRole('button', { name: 'common:modelLoad.dismiss' })
    )
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
    fireEvent.click(
      screen.getByRole('button', { name: 'common:modelLoad.dismiss' })
    )
    await waitFor(() => expect(snackbar()).not.toBeInTheDocument())
    act(() => useAppState.getState().updateLoadingModel(false))

    startLoad('restart')

    await waitFor(() => expect(snackbar()).toBeInTheDocument())
    expect(
      screen.getByText('common:inferenceStatus.restarting:Qwen3 8B')
    ).toBeInTheDocument()
  })

  it('says nothing about a remote provider', async () => {
    seed({}, 'openai')
    renderSnackbar()
    startLoad()

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(snackbar()).not.toBeInTheDocument()
  })
})
