import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { RunSettingsPanel } from '@/containers/RunSettingsPanel'
import { useAssistant } from '@/hooks/useAssistant'
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
})
