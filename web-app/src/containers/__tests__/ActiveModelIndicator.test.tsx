import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppState } from '@/hooks/useAppState'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useModelProvider } from '@/hooks/useModelProvider'
import { cancelModelLoad, unloadModelByUser } from '@/utils/switchModel'
import { ActiveModelIndicator } from '../ActiveModelIndicator'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options?.model ? `${key}:${options.model}` : key,
  }),
}))

vi.mock('@/utils/switchModel', () => ({
  cancelModelLoad: vi.fn(),
  unloadModelByUser: vi.fn(),
}))

const serviceHub = {}
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => serviceHub,
}))

const MODEL = 'Qwen3-8B'

const seed = (
  app: Partial<ReturnType<typeof useAppState.getState>>,
  provider = 'llamacpp-upstream'
) => {
  act(() => {
    useAppState.setState({
      activeModels: [],
      loadingModel: false,
      loadingModelId: undefined,
      loadingModelKind: undefined,
      loadingModelCancelling: false,
      ...app,
    })
    useModelProvider.setState({
      selectedProvider: provider,
      selectedModel: { id: MODEL } as never,
    })
  })
}

const indicator = () => screen.queryByTestId('active-model-indicator')

describe('ActiveModelIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useModelLoad.setState({
      modelLoadError: undefined,
      modelLoadErrorModelId: undefined,
    })
  })

  it('unloads a loaded model in one click', async () => {
    seed({ activeModels: [MODEL] })
    render(<ActiveModelIndicator />)

    expect(indicator()).toHaveAttribute('data-status', 'ready')
    fireEvent.click(indicator()!)

    await waitFor(() =>
      expect(unloadModelByUser).toHaveBeenCalledWith({
        modelId: MODEL,
        providerName: 'llamacpp-upstream',
        serviceHub,
      })
    )
  })

  it('holds still while the unload runs', async () => {
    let finishUnload: () => void = () => {}
    vi.mocked(unloadModelByUser).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishUnload = resolve
        })
    )
    seed({ activeModels: [MODEL] })
    render(<ActiveModelIndicator />)

    fireEvent.click(indicator()!)

    await waitFor(() =>
      expect(indicator()).toHaveAttribute('data-status', 'unloading')
    )
    expect(indicator()).toBeDisabled()
    fireEvent.click(indicator()!)
    expect(unloadModelByUser).toHaveBeenCalledTimes(1)

    await act(async () => {
      finishUnload()
    })
  })

  it('stops a load in flight from the same dot', () => {
    seed({ loadingModel: true, loadingModelId: MODEL })
    render(<ActiveModelIndicator />)

    expect(indicator()).toHaveAttribute('data-status', 'loading')
    fireEvent.click(indicator()!)

    expect(cancelModelLoad).toHaveBeenCalledWith(serviceHub)
    expect(unloadModelByUser).not.toHaveBeenCalled()
  })

  it('cannot be clicked again while a cancel is under way', () => {
    seed({
      loadingModel: true,
      loadingModelId: MODEL,
      loadingModelCancelling: true,
    })
    render(<ActiveModelIndicator />)

    expect(indicator()).toBeDisabled()
  })

  it('shows a model that is not in memory, without an action', () => {
    seed({})
    render(<ActiveModelIndicator />)

    expect(indicator()).toHaveAttribute('data-status', 'notLoaded')
    expect(indicator()?.tagName).not.toBe('BUTTON')
  })

  it('shows a failed load', () => {
    useModelLoad.setState({
      modelLoadError: { message: 'boom' } as never,
      modelLoadErrorModelId: MODEL,
    })
    seed({})
    render(<ActiveModelIndicator />)

    expect(indicator()).toHaveAttribute('data-status', 'failed')
  })

  it('is absent for a remote model, which holds nothing in memory', () => {
    seed({ activeModels: [MODEL] }, 'openai')
    const { container } = render(<ActiveModelIndicator />)

    expect(container).toBeEmptyDOMElement()
  })
})
