import { DEFAULT_CTX_LEN } from '@janhq/core'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { RunSettingsPanel } from '@/containers/RunSettingsPanel'
import { defaultAssistant, useAssistant } from '@/hooks/useAssistant'
import { formatContextSize } from '@/hooks/useModelContextLength'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import type { ServiceHub } from '@/services'
import type { ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  global.ResizeObserver = MockResizeObserver
})

// emoji-picker-react probes the DOM with selectors jsdom rejects, and the
// assistant dialog under test does not need a live picker.
vi.mock('emoji-picker-react', () => ({
  default: () => null,
  Theme: { LIGHT: 'light', DARK: 'dark', AUTO: 'auto' },
}))

vi.mock('@/containers/dynamicControllerSetting', () => ({
  DynamicControllerSetting: ({ title }: { title: string }) => (
    <button type="button">{title}</button>
  ),
}))

const updateAssistantParam = vi.fn()
const onClose = vi.fn()

function seedModel(providerName: string) {
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
          value: 8192,
          min: 0,
          max: 65536,
          step: 1024,
        },
      },
      ngl: {
        key: 'ngl',
        title: 'GPU Layers',
        description: 'Layers offloaded to the GPU.',
        controller_type: 'input',
        controller_props: { type: 'number', value: 99 },
      },
    },
  } as unknown as Model
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

describe('RunSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedServiceHub({
      models: {
        stopModel: vi.fn(),
        startModel: vi.fn(),
        getActiveModels: vi.fn().mockResolvedValue([]),
      } as unknown as ModelsService,
    })
    useThreads.setState({ currentThreadId: undefined })
    useAssistant.setState({
      assistants: [
        {
          id: 'writer',
          name: 'Writer',
          avatar: '✍️',
          instructions: 'Be terse.',
          parameters: { temperature: 0.3 },
        } as unknown as Assistant,
      ],
      defaultAssistantId: 'writer',
      pendingAssistant: undefined,
      updateAssistantParam,
    })
  })

  it('shows the active assistant and edits its sampling in place', () => {
    seedModel('llamacpp')
    render(<RunSettingsPanel onClose={onClose} />)

    expect(screen.getByText('chat:runSettings.title')).toBeInTheDocument()
    expect(screen.getByText('Writer')).toBeInTheDocument()

    fireEvent.change(screen.getByDisplayValue('0.3'), {
      target: { value: '1.2' },
    })
    expect(updateAssistantParam).toHaveBeenCalledWith(
      'writer',
      'temperature',
      1.2
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'chat:runSettings.close' })
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('creates an assistant from the dropdown and makes it the active one', async () => {
    const createAssistant = vi.fn().mockResolvedValue(undefined)
    seedServiceHub({
      models: {
        stopModel: vi.fn(),
        startModel: vi.fn(),
        getActiveModels: vi.fn().mockResolvedValue([]),
      } as unknown as ModelsService,
      assistants: {
        createAssistant,
      } as unknown as ReturnType<ServiceHub['assistants']>,
    })
    seedModel('llamacpp')
    render(<RunSettingsPanel onClose={onClose} />)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Writer/ }))
    await user.click(
      await screen.findByRole('menuitem', { name: 'assistants:addAssistant' })
    )

    const nameField = await screen.findByPlaceholderText('assistants:enterName')
    fireEvent.change(nameField, { target: { value: 'Reviewer' } })
    fireEvent.click(screen.getByRole('button', { name: 'assistants:save' }))

    const state = useAssistant.getState()
    expect(state.assistants.map((a) => a.name)).toContain('Reviewer')
    expect(state.pendingAssistant?.name).toBe('Reviewer')
    expect(createAssistant).toHaveBeenCalled()
  })

  it('edits the active assistant system prompt in place', () => {
    seedServiceHub({
      models: {
        stopModel: vi.fn(),
        startModel: vi.fn(),
        getActiveModels: vi.fn().mockResolvedValue([]),
      } as unknown as ModelsService,
      assistants: {
        createAssistant: vi.fn().mockResolvedValue(undefined),
      } as unknown as ReturnType<ServiceHub['assistants']>,
    })
    seedModel('llamacpp')
    render(<RunSettingsPanel onClose={onClose} />)

    const field = screen.getByLabelText('assistants:instructions')
    expect(field).toHaveValue('Be terse.')

    fireEvent.change(field, { target: { value: 'Answer in Russian.' } })

    expect(field).toHaveValue('Answer in Russian.')
    expect(useAssistant.getState().assistants[0].instructions).toBe(
      'Answer in Russian.'
    )
  })

  it('reveals the model load options behind the advanced switch', () => {
    seedModel('llamacpp')
    render(<RunSettingsPanel onClose={onClose} />)

    expect(screen.getByText('chat:runSettings.model')).toBeInTheDocument()
    expect(screen.getByText('8.0K')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'GPU Layers' })
    ).not.toBeInTheDocument()

    act(() => {
      fireEvent.click(
        screen.getByRole('switch', {
          name: 'chat:runSettings.advancedSettings',
        })
      )
    })
    expect(
      screen.getByRole('button', { name: 'GPU Layers' })
    ).toBeInTheDocument()
    // Context length has its own slider above, so it is not listed twice.
    expect(
      screen.queryByRole('button', { name: 'Context Size' })
    ).not.toBeInTheDocument()
  })

  it('hides the model section for providers without a context knob', () => {
    seedModel('openai')
    render(<RunSettingsPanel onClose={onClose} />)

    expect(screen.queryByText('chat:runSettings.model')).not.toBeInTheDocument()
    expect(
      screen.getByText('assistants:paramCategory.penalties')
    ).toBeInTheDocument()
  })

  it('puts dragged sliders back on the defaults in one click', () => {
    const createAssistant = vi.fn().mockResolvedValue(undefined)
    seedServiceHub({
      models: {
        stopModel: vi.fn(),
        startModel: vi.fn(),
        getActiveModels: vi.fn().mockResolvedValue([]),
      } as unknown as ModelsService,
      assistants: {
        createAssistant,
      } as unknown as ReturnType<ServiceHub['assistants']>,
    })
    useAssistant.setState({
      assistants: [
        {
          id: 'writer',
          name: 'Writer',
          avatar: '✍️',
          instructions: 'Be terse.',
          parameters: { temperature: 1.5, top_p: 0.35, min_p: 0.83, stream: false },
          sampling_overridden: true,
        } as unknown as Assistant,
      ],
    })
    seedModel('llamacpp')
    render(<RunSettingsPanel onClose={onClose} />)
    expect(screen.getByDisplayValue('1.5')).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'chat:runSettings.resetSampling' })
    )

    // The sliders the user sees are back where a new assistant starts:
    // top_p 0.8, top_k 20, repeat 1.12, and Min P on its engine default.
    for (const dragged of ['1.5', '0.35', '0.83']) {
      expect(screen.queryByDisplayValue(dragged)).not.toBeInTheDocument()
    }
    for (const restored of ['0.8', '20', '1.12', '0.05']) {
      expect(screen.getByDisplayValue(restored)).toBeInTheDocument()
    }

    // Only sampling was touched, and the reset is saved, not just shown.
    const [assistant] = useAssistant.getState().assistants
    expect(assistant.parameters).toEqual({
      stream: false,
      temperature: 0.7,
      top_k: 20,
      top_p: 0.8,
      repeat_penalty: 1.12,
    })
    expect(assistant.sampling_overridden).toBe(false)
    expect(assistant.instructions).toBe('Be terse.')
    expect(createAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'writer', sampling_overridden: false })
    )

    // Nothing is left to reset; the model's load options were never part of it.
    expect(
      screen.getByRole('button', { name: 'chat:runSettings.resetSampling' })
    ).toBeDisabled()
    expect(
      useModelProvider.getState().selectedModel?.settings?.ngl.controller_props
        .value
    ).toBe(99)
  })

  it('puts the model load options back on their defaults and restarts a loaded model', async () => {
    const stopModel = vi.fn().mockResolvedValue({ success: true })
    const startModel = vi.fn().mockResolvedValue(undefined)
    seedServiceHub({
      models: {
        stopModel,
        startModel,
        getActiveModels: vi.fn().mockResolvedValue(['test-model']),
      } as unknown as ModelsService,
    })
    seedModel('llamacpp')
    render(<RunSettingsPanel onClose={onClose} />)
    expect(screen.getByText('8.0K')).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'chat:runSettings.resetModel' })
    )

    // The context readout the user sees moves with it.
    expect(
      screen.getByText(formatContextSize(DEFAULT_CTX_LEN))
    ).toBeInTheDocument()
    const [model] = useModelProvider.getState().providers[0].models
    expect(model.settings?.ctx_len.controller_props.value).toBe(DEFAULT_CTX_LEN)
    expect(model.settings?.ngl.controller_props.value).toBe(100)
    // Sampling belongs to the other section's reset.
    expect(useAssistant.getState().assistants[0].parameters).toEqual({
      temperature: 0.3,
    })

    // Context size and GPU layers only apply on load.
    await waitFor(() => expect(startModel).toHaveBeenCalled())
    expect(stopModel).toHaveBeenCalledWith('test-model', 'llamacpp')
    expect(
      screen.getByRole('button', { name: 'chat:runSettings.resetModel' })
    ).toBeDisabled()
  })

  it('keeps both resets in place but disabled while everything is on its default', () => {
    useAssistant.setState({
      assistants: [
        {
          id: 'writer',
          name: 'Writer',
          avatar: '✍️',
          instructions: '',
          parameters: { ...defaultAssistant.parameters },
        } as unknown as Assistant,
      ],
    })
    seedModel('llamacpp')
    const [model] = useModelProvider.getState().providers[0].models
    useModelProvider.getState().updateProvider('llamacpp', {
      models: [
        {
          ...model,
          settings: {
            ...model.settings,
            ctx_len: {
              ...model.settings!.ctx_len,
              controller_props: {
                ...model.settings!.ctx_len.controller_props,
                value: DEFAULT_CTX_LEN,
              },
            },
            ngl: {
              ...model.settings!.ngl,
              controller_props: { type: 'number', value: 100 },
            },
          },
        } as Model,
      ],
    })
    render(<RunSettingsPanel onClose={onClose} />)

    for (const name of [
      'chat:runSettings.resetModel',
      'chat:runSettings.resetSampling',
    ]) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
  })
})
