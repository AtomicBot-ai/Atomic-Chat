import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ContextSizeControl } from '@/containers/ContextSizeControl'
import { useModelProvider } from '@/hooks/useModelProvider'

const stopModel = vi.fn()
const startModel = vi.fn()
const getActiveModels = vi.fn()
const syncActiveModelsFromEngines = vi.fn()

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  global.ResizeObserver = MockResizeObserver
})

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    models: () => ({
      stopModel,
      startModel,
      getActiveModels,
    }),
  }),
}))

vi.mock('@/hooks/useTokensCount', () => ({
  useTokensCount: () => ({
    tokenCount: 164,
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
    getActiveModels.mockResolvedValue([])
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

  it('keeps the previous token usage details inside the context editor', () => {
    setSelectedModel('llamacpp')
    render(<ContextSizeControl />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Context usage: 1.0%' })
    )

    expect(screen.getByText('Text')).toBeInTheDocument()
    expect(screen.getByText('Remaining')).toBeInTheDocument()
    expect(screen.getByText('164')).toBeInTheDocument()
    expect(screen.getByText('164 / 16.4K')).toBeInTheDocument()
    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuemax',
      '65536'
    )
  })

  it('persists the edited context size through the model provider store', () => {
    setSelectedModel('llamacpp')
    render(<ContextSizeControl />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Context usage: 1.0%' })
    )
    const slider = screen.getByRole('slider')
    fireEvent.keyDown(slider, { key: 'End' })
    fireEvent.keyUp(slider, { key: 'End' })

    expect(
      useModelProvider.getState().selectedModel?.settings?.ctx_len
        ?.controller_props.value
    ).toBe(65536)
  })

  it('restarts a running model after the context size changes', async () => {
    vi.useFakeTimers()
    getActiveModels.mockResolvedValue(['test-model'])
    setSelectedModel('mlx')
    render(<ContextSizeControl />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Context usage: 1.0%' })
    )
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
