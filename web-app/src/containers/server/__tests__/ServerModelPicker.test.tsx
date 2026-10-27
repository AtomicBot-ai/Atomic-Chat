import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { control, restart, helpers, toastError, navigate } = vi.hoisted(() => {
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
    navigate: vi.fn(),
  }
})

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: Record<string, never>) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
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
import { useOnboardingStore } from '@/stores/onboarding-store'
import { useServerPickerRequest } from '@/stores/server-picker-request-store'

import { isServableEngine, ServerModelPicker } from '../ServerModelPicker'

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

  /**
   * The dropdown's options, as it lists them under the field: by name, which
   * the engine and model rows set in bold above what they are.
   */
  const optionsOf = async (name: string) => {
    await user.click(dropdown(name))
    const options = screen
      .getAllByRole('menuitemradio')
      .map(
        (option) => (option.querySelector('strong') ?? option).textContent ?? ''
      )
    await user.keyboard('{Escape}')
    return options
  }
  /** The open menu's row whose name is `option`. */
  const row = (option: string) =>
    screen
      .getAllByRole('menuitemradio')
      .find(
        (item) => (item.querySelector('strong') ?? item).textContent === option
      ) as HTMLElement
  const choose = async (name: string, option: string) => {
    await user.click(dropdown(name))
    await user.click(row(option))
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
    useServerPickerRequest.setState({ target: null, nonce: 0 })
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

  it('shows each engine with its mark, what it is and its facts, and ticks the one chosen', async () => {
    render(<ServerModelPicker />)
    // The field reads as its chosen row does.
    expect(dropdown('api:model.engine')).toHaveTextContent(
      'api:model.engineDetail.llamacpp'
    )

    await user.click(dropdown('api:model.engine'))

    const llama = row(getProviderTitle('llamacpp-upstream'))
    expect(llama).toHaveAttribute('aria-checked', 'true')
    expect(llama.querySelector('img')).toHaveAttribute(
      'src',
      '/images/model-provider/llamacpp.svg'
    )
    expect(llama).toHaveTextContent('api:model.engineDetail.llamacpp')
    // One chat model: the embedding model and the missing file do not count.
    expect(llama).toHaveTextContent('GGUF · api:model.engineModels:{"count":1}')
    expect(row(getProviderTitle('atomic-prism'))).toHaveAttribute(
      'aria-checked',
      'false'
    )
  })

  it('describes the LiteRT-LM engine as it does the others', async () => {
    useModelProvider.setState({
      providers: [
        engine('litert-lm', [{ id: 'gemma-4-e2b-it', name: 'Gemma 4 E2B' }]),
      ],
    })
    render(<ServerModelPicker />)

    await user.click(dropdown('api:model.engine'))

    const litert = row(getProviderTitle('litert-lm'))
    expect(litert.querySelector('img')).toHaveAttribute(
      'src',
      '/images/model-provider/litert-lm.svg'
    )
    expect(litert).toHaveTextContent('api:model.engineDetail.litert')
    expect(litert).toHaveTextContent(
      'LiteRT-LM · api:model.engineModels:{"count":1}'
    )
  })

  it('shows each model with its family’s mark, the quantization its name leaves out and its size on disk', async () => {
    useModelProvider.setState({
      providers: [
        engine('llamacpp-upstream', [
          {
            id: 'unsloth/Llama-3.2-3B-Instruct-GGUF/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
            name: 'Llama 3.2 3B',
            sizeBytes: 2.5 * 1024 ** 3,
          },
          { id: 'my-finetune', description: 'Tuned on our support tickets' },
        ]),
      ],
    })
    render(<ServerModelPicker />)

    await user.click(dropdown('api:model.model'))

    const llama = row('Llama 3.2 3B')
    expect(llama.querySelector('img')).toHaveAttribute(
      'src',
      '/svg/meta-color.svg'
    )
    expect(within(llama).getByText(/Q4_K_M/)).toHaveTextContent(
      'Q4_K_M · api:model.onDisk:{"size":"2.5 GB"}'
    )
    // No family to go by: the engine's mark, and its own description.
    const finetune = row('my-finetune')
    expect(finetune.querySelector('img')).toHaveAttribute(
      'src',
      '/images/model-provider/llamacpp.svg'
    )
    expect(finetune).toHaveTextContent('Tuned on our support tickets')
    expect(finetune.querySelector('small')).toBeNull()
  })

  it('keeps the model on an engine that also runs it', async () => {
    useModelProvider.setState({
      providers: [
        engine('llamacpp-upstream', [
          { id: 'qwen3.5-4b' },
          { id: 'gemma-4-e4b' },
        ]),
        engine('atomic-prism', [{ id: 'bonsai-9b' }, { id: 'gemma-4-e4b' }]),
      ],
    })
    render(<ServerModelPicker />)

    await choose('api:model.model', 'gemma-4-e4b')
    await choose('api:model.engine', getProviderTitle('atomic-prism'))

    expect(dropdown('api:model.model')).toHaveTextContent('gemma-4-e4b')
    await user.click(saveButton())
    await waitFor(() =>
      expect(useLocalApiServer.getState().defaultModelLocalApiServer).toEqual({
        provider: 'atomic-prism',
        model: 'gemma-4-e4b',
      })
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
    // The field goes back to what runs and the bar leaves: nothing was kept.
    expect(dropdown('api:model.embeddingModel')).toHaveTextContent(
      'api:model.none'
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
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

  it('tells an engine the server runs from one it does not, models or not', () => {
    expect(isServableEngine(engine('llamacpp-upstream', []))).toBe(true)
    expect(isServableEngine(engine('vllm', [{ id: 'm' }], false))).toBe(false)
    expect(isServableEngine(engine('openai', [{ id: 'gpt-4.1' }]))).toBe(false)
  })

  describe('when the tray asks for a picker', () => {
    /** The open menu's rows, by name. */
    const openRows = () =>
      within(screen.getByRole('menu'))
        .getAllByRole('menuitemradio')
        .map(
          (option) =>
            (option.querySelector('strong') ?? option).textContent ?? ''
        )

    it('opens the model picker on arrival, once, and leaves it to the user after', async () => {
      useServerPickerRequest.getState().request('model')
      render(<ServerModelPicker />)

      // The menu is named by its field, so this is the model picker's.
      expect(
        await screen.findByRole('menu', { name: 'api:model.model' })
      ).toBeInTheDocument()
      expect(openRows()).toEqual(['Qwen3.5 4B'])
      expect(useServerPickerRequest.getState().target).toBeNull()

      await user.keyboard('{Escape}')
      await waitFor(() =>
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      )
      // Still a plain dropdown: the user opens the other one as before.
      await user.click(dropdown('api:model.engine'))
      expect(openRows()).toEqual([
        getProviderTitle('llamacpp-upstream'),
        getProviderTitle('atomic-prism'),
      ])
    })

    it('opens the engine picker when asked while the page is already on screen', async () => {
      render(<ServerModelPicker />)
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()

      act(() => useServerPickerRequest.getState().request('engine'))

      expect(
        await screen.findByRole('menu', { name: 'api:model.engine' })
      ).toBeInTheDocument()
      expect(openRows()).toEqual([
        getProviderTitle('llamacpp-upstream'),
        getProviderTitle('atomic-prism'),
      ])
      expect(useServerPickerRequest.getState().target).toBeNull()
    })

    it('drops the request when there is no engine to pick from', () => {
      useModelProvider.setState({
        providers: [engine('openai', [{ id: 'x' }])],
      })
      useServerPickerRequest.getState().request('engine')
      render(<ServerModelPicker />)

      expect(screen.getByText('api:model.emptyTitle')).toBeInTheDocument()
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(useServerPickerRequest.getState().target).toBeNull()
    })
  })

  describe('on first-run setup’s endpoint hints', () => {
    const guideHint = () =>
      screen.queryByRole('region', { name: 'onboarding-server:guide.label' })

    beforeEach(() => {
      const store = useOnboardingStore.getState()
      store.reset()
      store.begin('full', 'server')
      store.handOff('endpoint')
      store.setGuide({ path: 'endpoint', hint: 1 })
    })

    it('shows "Choose the model", and Next hint goes on to Start', async () => {
      render(<ServerModelPicker />)

      expect(guideHint()).toHaveTextContent(
        'onboarding-server:guide.model.title'
      )
      await user.click(
        screen.getByRole('button', { name: 'onboarding-server:guide.next' })
      )

      expect(navigate).toHaveBeenCalledWith({ to: '/api/' })
      expect(useOnboardingStore.getState().guide).toEqual({
        path: 'endpoint',
        hint: 2,
      })
      expect(guideHint()).toBeNull()
    })

    it('shows it over the empty state while the model is still downloading', () => {
      useModelProvider.setState({ providers: [] })
      render(<ServerModelPicker />)

      expect(guideHint()).toHaveTextContent(
        'onboarding-server:guide.model.title'
      )
      expect(screen.getByText('api:model.emptyTitle')).toBeInTheDocument()
    })
  })
})
