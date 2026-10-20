import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { control, restart, helpers, toastError } = vi.hoisted(() => {
  const helper = () => ({
    supported: true,
    options: [] as { value: string; label: string }[],
    active: 'none',
    apply: vi.fn(),
  })
  return {
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
    helpers: { embedding: helper(), decision: helper() },
    toastError: vi.fn(),
  }
})

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
vi.mock('sonner', () => ({ toast: { error: toastError } }))

// The embedding and decision stores talk to the core; the page only needs
// what they offer, which model runs and how to change it.
vi.mock('../useServedHelperModels', () => ({
  NO_HELPER_MODEL: 'none',
  useServedEmbeddingModels: () => helpers.embedding,
  useServedDecisionModels: () => helpers.decision,
}))

import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import { getProviderTitle } from '@/lib/utils'

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

const dropdown = (name: string) => screen.getByRole('button', { name })
const saveButton = () =>
  screen.getByRole('button', { name: 'settings:serverConfig.save' })

describe('Server → Engine & model', () => {
  const user = userEvent.setup()

  /** The dropdown's options, as it lists them under the field. */
  const optionsOf = async (name: string) => {
    await user.click(dropdown(name))
    const options = screen
      .getAllByRole('menuitemradio')
      .map((option) => option.textContent)
    await user.keyboard('{Escape}')
    return options
  }
  const choose = async (name: string, option: string) => {
    await user.click(dropdown(name))
    await user.click(screen.getByRole('menuitemradio', { name: option }))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    control.status = 'stopped'
    control.isRunning = false
    restart.mockResolvedValue(true)
    for (const helper of [helpers.embedding, helpers.decision]) {
      helper.supported = true
      helper.options = []
      helper.active = 'none'
      helper.apply.mockResolvedValue(undefined)
    }
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

  it('lists enabled local engines with a chat model, and only those models', async () => {
    render(<ServerModelPicker />)

    expect(await optionsOf('api:model.engine')).toEqual([
      getProviderTitle('llamacpp-upstream'),
      getProviderTitle('atomic-prism'),
    ])
    expect(await optionsOf('api:model.model')).toEqual(['Qwen3.5 4B'])
    // Nothing to save yet, so no save bar.
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('opens on the saved choice', () => {
    useLocalApiServer.setState({
      defaultModelLocalApiServer: {
        model: 'bonsai-9b',
        provider: 'atomic-prism',
      },
    })
    render(<ServerModelPicker />)

    expect(dropdown('api:model.engine')).toHaveTextContent(
      getProviderTitle('atomic-prism')
    )
    expect(dropdown('api:model.model')).toHaveTextContent('bonsai-9b')
  })

  it('opens its list under the field rather than over it', async () => {
    render(<ServerModelPicker />)

    await user.click(dropdown('api:model.engine'))

    expect(screen.getByRole('menu')).toHaveAttribute('data-side', 'bottom')
  })

  it('replaces a model the new engine cannot run, and saves without a restart while stopped', async () => {
    render(<ServerModelPicker />)

    await choose('api:model.engine', getProviderTitle('atomic-prism'))
    expect(dropdown('api:model.model')).toHaveTextContent('bonsai-9b')
    expect(screen.getByRole('status')).toHaveTextContent(
      'settings:serverConfig.unsaved'
    )

    await user.click(saveButton())

    await waitFor(() =>
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    )
    expect(useLocalApiServer.getState().defaultModelLocalApiServer).toEqual({
      provider: 'atomic-prism',
      model: 'bonsai-9b',
    })
    expect(restart).not.toHaveBeenCalled()
  })

  it('applies a new model to a running server with Save, which brings it back serving that model', async () => {
    control.status = 'running'
    control.isRunning = true
    render(<ServerModelPicker />)

    await choose('api:model.engine', getProviderTitle('atomic-prism'))
    // No "Apply & restart": saving applies the change.
    expect(saveButton()).toHaveTextContent('settings:serverConfig.save')
    await user.click(saveButton())

    await waitFor(() =>
      expect(restart).toHaveBeenCalledWith({}, control, { ensureModel: true })
    )
    expect(useLocalApiServer.getState().defaultModelLocalApiServer?.model).toBe(
      'bonsai-9b'
    )
  })

  it('keeps the bar up to say a restart failed', async () => {
    control.status = 'running'
    control.isRunning = true
    restart.mockResolvedValue(false)
    render(<ServerModelPicker />)

    await choose('api:model.engine', getProviderTitle('atomic-prism'))
    await user.click(saveButton())

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'settings:serverConfig.restartFailed'
      )
    )
  })

  it('offers the downloaded embedding and decision models beside None, showing the ones served', async () => {
    helpers.embedding.options = [
      { value: 'catalog:qwen3-embedding-0.6b', label: 'Qwen3 Embedding 0.6B' },
      { value: 'local:bge-m3', label: 'bge-m3' },
    ]
    helpers.embedding.active = 'local:bge-m3'
    helpers.decision.options = [{ value: 'laya', label: 'Laya · TurboQuant' }]
    render(<ServerModelPicker />)

    expect(dropdown('api:model.embeddingModel')).toHaveTextContent('bge-m3')
    expect(dropdown('api:model.decisionModel')).toHaveTextContent(
      'api:model.none'
    )
    expect(await optionsOf('api:model.embeddingModel')).toEqual([
      'api:model.none',
      'Qwen3 Embedding 0.6B',
      'bge-m3',
    ])
    expect(await optionsOf('api:model.decisionModel')).toEqual([
      'api:model.none',
      'Laya · TurboQuant',
    ])
  })

  it('starts the chosen embedding model and switches the decision model off on Save, without touching the chat model', async () => {
    helpers.embedding.options = [
      { value: 'catalog:qwen3-embedding-0.6b', label: 'Qwen3 Embedding 0.6B' },
    ]
    helpers.decision.options = [{ value: 'laya', label: 'Laya · TurboQuant' }]
    helpers.decision.active = 'laya'
    render(<ServerModelPicker />)

    await choose('api:model.embeddingModel', 'Qwen3 Embedding 0.6B')
    await choose('api:model.decisionModel', 'api:model.none')
    await user.click(saveButton())

    await waitFor(() =>
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    )
    expect(helpers.embedding.apply).toHaveBeenCalledWith(
      'catalog:qwen3-embedding-0.6b'
    )
    expect(helpers.decision.apply).toHaveBeenCalledWith('none')
    expect(useLocalApiServer.getState().defaultModelLocalApiServer).toBeNull()
    expect(restart).not.toHaveBeenCalled()
  })

  it('says when a chosen model would not start', async () => {
    helpers.embedding.options = [{ value: 'local:bge-m3', label: 'bge-m3' }]
    helpers.embedding.apply.mockRejectedValue({
      code: 'EMBEDDING_ENGINE_UNSUPPORTED',
      message: 'llama.cpp b11400 is too old',
    })
    render(<ServerModelPicker />)

    await choose('api:model.embeddingModel', 'bge-m3')
    await user.click(saveButton())

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('api:model.helperFailed', {
        description: 'llama.cpp b11400 is too old',
      })
    )
  })

  it('leaves out a kind this desktop cannot run, and offers only None without downloads', () => {
    helpers.decision.supported = false
    render(<ServerModelPicker />)

    expect(
      screen.queryByRole('button', { name: 'api:model.decisionModel' })
    ).not.toBeInTheDocument()
    expect(dropdown('api:model.embeddingModel')).toBeDisabled()
    expect(screen.getByText('api:model.helperEmpty')).toBeInTheDocument()
  })

  it('sends the user to the Hub when there is no chat model, and still offers the others', () => {
    useModelProvider.setState({ providers: [engine('openai', [{ id: 'x' }])] })
    helpers.embedding.options = [{ value: 'local:bge-m3', label: 'bge-m3' }]
    render(<ServerModelPicker />)

    expect(screen.getByText('api:model.emptyTitle')).toBeInTheDocument()
    expect(screen.getByText('api:model.openHub').closest('a')).toHaveAttribute(
      'href',
      '/hub/'
    )
    expect(dropdown('api:model.embeddingModel')).toBeEnabled()
  })
})
