import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ModelSetting } from '@/containers/ModelSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { CTX_LEN_USER_SET_KEY } from '@/lib/planned-context-window'
import type { ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'

const stopModel = vi.fn()
const startModel = vi.fn()
const getActiveModels = vi.fn()

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SheetTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SheetContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SheetHeader: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))

vi.mock('@/containers/dynamicControllerSetting', () => ({
  DynamicControllerSetting: ({
    title,
    controllerProps,
    onChange,
  }: {
    title: string
    controllerProps: { value?: string | boolean | number }
    onChange: (value: string | boolean | number) => void
  }) => (
    <button
      type="button"
      onClick={() =>
        onChange(
          typeof controllerProps.value === 'boolean'
            ? !controllerProps.value
            : 'layers.0=CPU'
        )
      }
    >
      {title}
    </button>
  ),
}))

function setupModelSetting(extra: Record<string, unknown> = {}) {
  const model = {
    id: 'test-model',
    name: 'Test model',
    settings: {
      ...extra,
      no_kv_offload: {
        key: 'no_kv_offload',
        title: 'Disable KV Offload',
        description: 'Disable KV cache offload.',
        controller_type: 'checkbox',
        controller_props: { value: false },
      },
      override_tensor_buffer_t: {
        key: 'override_tensor_buffer_t',
        title: 'Override Tensor Buffer Type',
        description: 'Override tensor placement.',
        controller_type: 'input',
        controller_props: { value: '' },
      },
    },
  } as Model
  const provider = {
    provider: 'llamacpp-upstream',
    models: [model],
  } as ModelProvider
  useModelProvider.setState({
    providers: [provider],
    selectedProvider: provider.provider,
    selectedModel: model,
  })
  render(<ModelSetting model={model} provider={provider} />)
}

describe('ModelSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    getActiveModels.mockResolvedValue(['test-model'])
    seedServiceHub({
      models: {
        stopModel,
        startModel,
        getActiveModels,
      } as unknown as ModelsService,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['Disable KV Offload', 'no_kv_offload', true],
    ['Override Tensor Buffer Type', 'override_tensor_buffer_t', 'layers.0=CPU'],
  ])(
    'restarts a running model after changing %s',
    async (title, key, value) => {
      setupModelSetting()

      fireEvent.click(screen.getByRole('button', { name: title }))
      await act(async () => {
        await Promise.resolve()
        vi.advanceTimersByTime(500)
        await Promise.resolve()
        await Promise.resolve()
      })

      const provider = useModelProvider
        .getState()
        .getProviderByName('llamacpp-upstream')
      expect(provider?.models[0].settings?.[key].controller_props.value).toBe(
        value
      )
      expect(stopModel).toHaveBeenCalledWith('test-model', 'llamacpp-upstream')
      expect(startModel).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'llamacpp-upstream' }),
        'test-model',
        true
      )
    }
  )

  it('marks a context size typed here as chosen by the user, and never lists the mark', async () => {
    setupModelSetting({
      ctx_len: {
        key: 'ctx_len',
        title: 'Context Size',
        description: 'Size of the prompt context.',
        controller_type: 'input',
        controller_props: { value: 16384 },
      },
      [CTX_LEN_USER_SET_KEY]: {
        key: CTX_LEN_USER_SET_KEY,
        title: 'Context Size Chosen By User',
        description: '',
        controller_type: 'checkbox',
        controller_props: { value: false },
      },
    })
    expect(
      screen.queryByRole('button', { name: 'Context Size Chosen By User' })
    ).toBeNull()

    const settings = () =>
      useModelProvider.getState().getProviderByName('llamacpp-upstream')
        ?.models[0].settings
    // Any other setting leaves the mark as it was.
    fireEvent.click(screen.getByRole('button', { name: 'Disable KV Offload' }))
    expect(settings()?.[CTX_LEN_USER_SET_KEY]?.controller_props.value).toBe(
      false
    )

    fireEvent.click(screen.getByRole('button', { name: 'Context Size' }))
    expect(settings()?.[CTX_LEN_USER_SET_KEY]?.controller_props.value).toBe(
      true
    )
    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })
  })
})
