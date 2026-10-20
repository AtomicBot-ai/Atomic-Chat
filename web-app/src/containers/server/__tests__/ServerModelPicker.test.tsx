import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { control, restart } = vi.hoisted(() => ({
  control: {
    status: 'stopped' as 'running' | 'stopped' | 'pending',
    isRunning: false,
    isModelLoading: false,
    isBusy: false,
    start: vi.fn(),
    stop: vi.fn(),
    toggle: vi.fn(),
    refreshStatus: vi.fn(),
  },
  restart: vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: Record<string, never>) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}))

vi.mock('@/hooks/useLocalApiServerControl', () => ({
  useLocalApiServerControl: () => control,
}))

vi.mock('@/hooks/useRemoteAccess', () => ({ restartLocalApiServer: restart }))
vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => ({}) }))

import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'

import { ServerModelPicker } from '../ServerModelPicker'

/** A provider as the store holds it; cloud ones carry no `persist` flag. */
const engine = (
  provider: string,
  models: Partial<Model>[],
  active = true
): ModelProvider =>
  ({
    provider,
    active,
    persist: provider !== 'openai',
    settings: [],
    models: models.map((model) => ({ id: 'model', ...model })),
  }) as unknown as ModelProvider

const engineSelect = () =>
  screen.getByLabelText('api:model.engine') as HTMLSelectElement
const modelSelect = () =>
  screen.getByLabelText('api:model.model') as HTMLSelectElement
const optionsOf = (select: HTMLSelectElement) =>
  [...select.options].map((option) => option.value)
const saveButton = () =>
  screen.getByRole('button', {
    name: /settings:serverConfig\.(save|applyRestart)/,
  })

describe('Server → Engine & model', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    control.status = 'stopped'
    control.isRunning = false
    restart.mockResolvedValue(true)
    useLocalApiServer.setState({
      defaultModelLocalApiServer: null,
      lastServerModels: [],
    })
    useModelProvider.setState({
      providers: [
        engine('llamacpp-upstream', [
          { id: 'qwen3.5-4b', name: 'Qwen3.5 4B' },
          { id: 'bge-m3', embedding: true },
          { id: 'gone', missing: true },
        ]),
        engine('atomic-prism', [{ id: 'bonsai-9b' }]),
        engine('vllm', [{ id: 'llama-3.1-8b' }], false),
        engine('foundry-local', []),
        engine('openai', [{ id: 'gpt-4.1' }]),
      ],
    })
  })

  it('lists enabled local engines with a chat model, and only those models', () => {
    render(<ServerModelPicker />)

    expect(optionsOf(engineSelect())).toEqual([
      'llamacpp-upstream',
      'atomic-prism',
    ])
    expect(optionsOf(modelSelect())).toEqual(['qwen3.5-4b'])
    expect(screen.getByRole('status')).toHaveTextContent(
      'settings:serverConfig.allSaved'
    )
  })

  it('opens on the saved choice', () => {
    useLocalApiServer.setState({
      defaultModelLocalApiServer: {
        model: 'bonsai-9b',
        provider: 'atomic-prism',
      },
    })
    render(<ServerModelPicker />)

    expect(engineSelect().value).toBe('atomic-prism')
    expect(modelSelect().value).toBe('bonsai-9b')
  })

  it('replaces a model the new engine cannot run, and saves without a restart while stopped', async () => {
    render(<ServerModelPicker />)

    fireEvent.change(engineSelect(), { target: { value: 'atomic-prism' } })
    expect(modelSelect().value).toBe('bonsai-9b')
    expect(screen.getByRole('status')).toHaveTextContent(
      'settings:serverConfig.unsaved'
    )

    fireEvent.click(saveButton())

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'settings:serverConfig.saved'
      )
    )
    expect(useLocalApiServer.getState().defaultModelLocalApiServer).toEqual({
      provider: 'atomic-prism',
      model: 'bonsai-9b',
    })
    expect(restart).not.toHaveBeenCalled()
  })

  it('applies a new model to a running server by restarting it with that model', async () => {
    control.status = 'running'
    control.isRunning = true
    render(<ServerModelPicker />)
    expect(saveButton()).toHaveTextContent('settings:serverConfig.applyRestart')

    fireEvent.change(engineSelect(), { target: { value: 'atomic-prism' } })
    fireEvent.click(saveButton())

    await waitFor(() =>
      expect(restart).toHaveBeenCalledWith({}, control, { ensureModel: true })
    )
    expect(useLocalApiServer.getState().defaultModelLocalApiServer?.model).toBe(
      'bonsai-9b'
    )
  })

  it('sends the user to the Hub when there is nothing to serve', () => {
    useModelProvider.setState({ providers: [engine('openai', [{ id: 'x' }])] })
    render(<ServerModelPicker />)

    expect(screen.getByText('api:model.emptyTitle')).toBeInTheDocument()
    expect(screen.getByText('api:model.openHub').closest('a')).toHaveAttribute(
      'href',
      '/hub/'
    )
  })
})
