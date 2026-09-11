import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelSupportStatus } from '../ModelSupportStatus'
import { useAppState } from '@/hooks/useAppState'
import { useModelLoad } from '@/hooks/useModelLoad'
import { seedServiceHub } from '@/test/service-hub'

const mocks = vi.hoisted(() => ({
  isModelSupported: vi.fn(),
}))

vi.mock('@janhq/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@janhq/core')>()),
  getJanDataFolderPath: vi.fn().mockResolvedValue('/data'),
  joinPath: vi.fn(async (parts: string[]) => parts.join('/')),
  fs: { existsSync: vi.fn().mockResolvedValue(true) },
}))

const MODEL = 'LiquidAI/LFM2_5-2_6B-Q4_0'

const renderStatus = (provider = 'llamacpp-upstream') =>
  render(
    <ModelSupportStatus modelId={MODEL} provider={provider} contextSize={8192} />
  )

const indicator = () => screen.getByTestId('model-status-indicator')

describe('ModelSupportStatus', () => {
  beforeEach(() => {
    mocks.isModelSupported.mockReset().mockResolvedValue('GREEN')
    seedServiceHub({
      models: { isModelSupported: mocks.isModelSupported } as never,
    })
    useAppState.setState({ activeModels: [], loadingModel: false })
    useModelLoad.setState({
      modelLoadError: undefined,
      modelLoadErrorModelId: undefined,
    })
  })

  it('is green while the model is running', () => {
    useAppState.setState({ activeModels: [MODEL] })
    const { unmount } = renderStatus()

    expect(indicator()).toHaveAttribute('data-status', 'running')
    unmount()
  })

  it('goes out once the model is stopped, even though it fits the device', async () => {
    useAppState.setState({ activeModels: [MODEL] })
    const { unmount } = renderStatus()

    act(() => {
      useAppState.setState({ activeModels: [] })
    })

    // Fitting the device used to keep the dot green, so a Stop looked like it
    // had done nothing.
    await waitFor(() => expect(mocks.isModelSupported).toHaveBeenCalled())
    expect(indicator()).toHaveAttribute('data-status', 'stopped')
    expect(indicator()).toHaveAttribute(
      'aria-label',
      expect.stringContaining('not running')
    )
    unmount()
  })

  it('spins while the model is starting', () => {
    useAppState.setState({ loadingModel: true })
    const { unmount } = renderStatus()

    expect(indicator()).toHaveAttribute('data-status', 'starting')
    unmount()
  })

  it('still warns about a stopped model that will not fit', async () => {
    mocks.isModelSupported.mockResolvedValue('RED')
    const { unmount } = renderStatus()

    await waitFor(() =>
      expect(indicator()).toHaveAttribute('data-status', 'wontFit')
    )
    unmount()
  })

  it('does not re-probe the device on an engine re-sync that changes nothing', async () => {
    const { unmount } = renderStatus()
    await waitFor(() =>
      expect(mocks.isModelSupported).toHaveBeenCalledTimes(1)
    )

    // Every re-sync writes a fresh array; re-probing on each flashed a spinner.
    act(() => {
      useAppState.setState({ activeModels: [] })
    })
    act(() => {
      useAppState.setState({ activeModels: ['some-other-model'] })
    })

    expect(mocks.isModelSupported).toHaveBeenCalledTimes(1)
    expect(indicator()).toHaveAttribute('data-status', 'stopped')
    unmount()
  })

  it('reflects the engine for an MLX model too', () => {
    const { rerender, unmount } = renderStatus('mlx')
    expect(indicator()).toHaveAttribute('data-status', 'stopped')

    act(() => {
      useAppState.setState({ activeModels: [MODEL] })
    })
    rerender(
      <ModelSupportStatus modelId={MODEL} provider="mlx" contextSize={8192} />
    )
    expect(indicator()).toHaveAttribute('data-status', 'running')
    // The GGUF fit probe is llama.cpp-only.
    expect(mocks.isModelSupported).not.toHaveBeenCalled()
    unmount()
  })
})
