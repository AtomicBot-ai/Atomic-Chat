import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineManager, type ThreadMessage } from '@janhq/core'

import { ContextSizeControl } from '@/containers/ContextSizeControl'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'

const stopModel = vi.fn()
const startModel = vi.fn()
const getActiveModels = vi.fn()
const syncActiveModelsFromEngines = vi.fn()
const tokenCountState = vi.hoisted(() => ({ value: 164 }))

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  global.ResizeObserver = MockResizeObserver
})

vi.mock('@/hooks/useTokensCount', () => ({
  useTokensCount: () => ({
    tokenCount: tokenCountState.value,
    maxTokens: 16384,
    isNearLimit: false,
    loading: false,
    calculateTokens: vi.fn(),
  }),
}))

vi.mock('@/utils/activeModelsSync', () => ({
  syncActiveModelsFromEngines: (...args: unknown[]) =>
    syncActiveModelsFromEngines(...args),
}))

function setSelectedModel(providerName: string) {
  const model = {
    id: 'test-model',
    name: 'Test model',
    settings: {
      ctx_len: {
        key: 'ctx_len',
        title: 'Context Size',
        description: 'Size of the prompt context.',
        controller_type: 'input',
        controller_props: {
          type: 'number',
          value: 16384,
          min: 0,
          max: 65536,
          step: 1024,
        },
      },
    },
  } as Model
  const provider = {
    provider: providerName,
    models: [model],
  } as ModelProvider

  useModelProvider.setState({
    providers: [provider],
    selectedProvider: providerName,
    selectedModel: model,
  })
}

describe('ContextSizeControl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tokenCountState.value = 164
    getActiveModels.mockResolvedValue([])
    seedServiceHub({
      models: {
        stopModel,
        startModel,
        getActiveModels,
      } as unknown as ModelsService,
    })
  })

  it.each(['llamacpp', 'llamacpp-upstream', 'mlx'])(
    'is visible for %s models',
    (providerName) => {
      setSelectedModel(providerName)
      render(<ContextSizeControl />)

      expect(
        screen.getByRole('button', { name: 'Context usage: 1.0%' })
      ).toBeInTheDocument()
    }
  )

  it('is hidden for non-local providers', () => {
    setSelectedModel('openai')
    render(<ContextSizeControl />)

    expect(
      screen.queryByRole('button', { name: /Context usage:/ })
    ).not.toBeInTheDocument()
  })

  it('shows the current input and latest output token usage', () => {
    setSelectedModel('llamacpp')
    const messages = [
      {
        role: 'assistant',
        metadata: {
          usage: {
            outputTokens: 24,
          },
        },
      } as ThreadMessage,
    ]
    render(<ContextSizeControl messages={messages} />)

    fireEvent.click(screen.getByRole('button', { name: 'Context usage: 1.0%' }))

    expect(screen.getByText('Input')).toBeInTheDocument()
    expect(screen.getByText('Output')).toBeInTheDocument()
    expect(screen.queryByText('Remaining')).not.toBeInTheDocument()
    expect(screen.getByText('140')).toBeInTheDocument()
    expect(screen.getByText('24')).toBeInTheDocument()
    expect(screen.getByText('164 / 16.4K')).toBeInTheDocument()
    expect(screen.getByRole('progressbar').firstElementChild).toHaveClass(
      'bg-emerald-500'
    )
    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuemax',
      '524288'
    )
  })

  it('falls back to response usage when a new chat has not been tokenized', () => {
    tokenCountState.value = 0
    setSelectedModel('llamacpp')
    const messages = [
      {
        role: 'assistant',
        metadata: {
          usage: {
            inputTokens: 37,
            outputTokens: 11,
            totalTokens: 48,
          },
        },
      } as ThreadMessage,
    ]
    render(<ContextSizeControl messages={messages} />)

    fireEvent.click(screen.getByRole('button', { name: 'Context usage: 0.3%' }))

    expect(screen.getByText('37')).toBeInTheDocument()
    expect(screen.getByText('11')).toBeInTheDocument()
    expect(screen.getByText('48 / 16.4K')).toBeInTheDocument()
  })

  it.each([
    [12000, 'bg-orange-500'],
    [14700, 'bg-destructive'],
  ])(
    'changes the context progress tone at usage thresholds',
    (additionalTokens, expectedClass) => {
      setSelectedModel('llamacpp')
      render(<ContextSizeControl additionalTokens={additionalTokens} />)

      fireEvent.click(
        screen.getByRole('button', { name: /Context usage:/ })
      )

      expect(screen.getByRole('progressbar').firstElementChild).toHaveClass(
        expectedClass
      )
    }
  )

  it('persists the edited context size through the model provider store', () => {
    setSelectedModel('llamacpp')
    render(<ContextSizeControl />)

    fireEvent.click(screen.getByRole('button', { name: 'Context usage: 1.0%' }))
    const slider = screen.getByRole('slider')
    fireEvent.keyDown(slider, { key: 'End' })
    fireEvent.keyUp(slider, { key: 'End' })

    expect(
      useModelProvider.getState().selectedModel?.settings?.ctx_len
        ?.controller_props.value
    ).toBe(524288)
  })

  it('uses the model training limit when the engine provides one', async () => {
    const getMaxCtxTrain = vi.fn().mockResolvedValue(131072)
    const engineManager = vi
      .spyOn(EngineManager, 'instance')
      .mockReturnValue({
        get: () => ({ getMaxCtxTrain }),
      } as unknown as EngineManager)
    setSelectedModel('llamacpp')
    render(<ContextSizeControl />)

    fireEvent.click(screen.getByRole('button', { name: /Context usage:/ }))

    await waitFor(() =>
      expect(screen.getByRole('slider')).toHaveAttribute(
        'aria-valuemax',
        '131072'
      )
    )
    expect(getMaxCtxTrain).toHaveBeenCalledWith('test-model')
    engineManager.mockRestore()
  })

  it('restarts a running model after the context size changes', async () => {
    vi.useFakeTimers()
    getActiveModels.mockResolvedValue(['test-model'])
    setSelectedModel('mlx')
    render(<ContextSizeControl />)

    fireEvent.click(screen.getByRole('button', { name: 'Context usage: 1.0%' }))
    const slider = screen.getByRole('slider')
    fireEvent.keyDown(slider, { key: 'End' })
    fireEvent.keyUp(slider, { key: 'End' })

    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(stopModel).toHaveBeenCalledWith('test-model')
    expect(startModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'mlx' }),
      'test-model',
      true
    )
    expect(syncActiveModelsFromEngines).toHaveBeenCalled()
    vi.useRealTimers()
  })
})
