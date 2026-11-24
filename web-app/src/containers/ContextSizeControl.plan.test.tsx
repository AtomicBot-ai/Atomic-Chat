import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ContextSizeControl } from '@/containers/ContextSizeControl'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { ContextPlan } from '@/lib/core-context-contract'
import {
  CTX_LEN_USER_SET_KEY,
  isCtxLenUserSet,
} from '@/lib/planned-context-window'
import type { ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'

// The core's context plan behind the "Up to N on this device" hint, and the
// marker a slider commit leaves on the model.

const { fetchContextPlan } = vi.hoisted(() => ({
  fetchContextPlan:
    vi.fn<
      (providerId: string, modelId: string) => Promise<ContextPlan | undefined>
    >(),
}))

vi.mock('@/lib/context-plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/context-plan')>()),
  fetchContextPlan,
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
  syncActiveModelsFromEngines: vi.fn(),
}))

function selectModel(providerName = 'llamacpp-upstream') {
  const model = {
    id: 'org/model-Q4',
    name: 'Test model',
    settings: {
      ctx_len: {
        key: 'ctx_len',
        title: 'Context Size',
        description: 'Size of the prompt context.',
        controller_type: 'input',
        controller_props: { type: 'number', value: 16384, step: 1024 },
      },
    },
  } as Model
  useModelProvider.setState({
    providers: [
      { provider: providerName, models: [model], settings: [] } as never,
    ],
    selectedProvider: providerName,
    selectedModel: model,
  })
}

async function openPopover() {
  // The engine's and the core's answers land in state after the first render.
  await act(async () => {
    render(<ContextSizeControl />)
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Context usage/ }))
  })
}

describe('ContextSizeControl and the device plan', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedServiceHub({
      models: {
        stopModel: vi.fn(),
        startModel: vi.fn(),
        getActiveModels: vi.fn().mockResolvedValue([]),
      } as unknown as ModelsService,
    })
  })

  it('says how much context this device holds', async () => {
    fetchContextPlan.mockResolvedValue({
      recommendedCtx: 65536,
      maxCtx: 65536,
      trainedCtx: 65536,
      basis: 'unified',
    })
    selectModel()
    await openPopover()

    expect(fetchContextPlan).toHaveBeenCalledWith(
      'llamacpp-upstream',
      'org/model-Q4'
    )
    expect(
      await screen.findByTestId('context-size-device-max')
    ).toHaveTextContent('assistants:contextSizeDeviceMax')
  })

  it('names the training maximum when the device holds less', async () => {
    fetchContextPlan.mockResolvedValue({
      recommendedCtx: 49152,
      maxCtx: 49152,
      trainedCtx: 131072,
      basis: 'gpu',
    })
    selectModel()
    await openPopover()

    expect(
      await screen.findByTestId('context-size-device-max')
    ).toHaveTextContent('assistants:contextSizeDeviceMaxBelowTrained')
  })

  it('shows no hint without a plan (an older core)', async () => {
    fetchContextPlan.mockResolvedValue(undefined)
    selectModel()
    await openPopover()

    expect(fetchContextPlan).toHaveBeenCalled()
    expect(screen.queryByTestId('context-size-device-max')).toBeNull()
  })

  it('marks a context the user commits on the slider as chosen by hand', async () => {
    fetchContextPlan.mockResolvedValue(undefined)
    selectModel()
    await openPopover()

    const model = () =>
      useModelProvider.getState().getProviderByName('llamacpp-upstream')
        ?.models[0]
    expect(isCtxLenUserSet(model()?.settings)).toBe(false)

    await act(async () => {
      fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' })
    })

    expect(model()?.settings?.ctx_len.controller_props.value).toBe(17408)
    expect(model()?.settings?.[CTX_LEN_USER_SET_KEY]).toMatchObject({
      controller_props: { value: true },
    })
  })
})
