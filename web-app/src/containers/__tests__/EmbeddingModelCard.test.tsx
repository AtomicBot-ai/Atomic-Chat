import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  EmbeddingModelState,
  EmbeddingRunState,
} from '@/hooks/useEmbeddingModel'

const state = vi.hoisted(() => ({
  current: {} as EmbeddingModelState,
  local: {} as EmbeddingRunState,
}))
const navigate = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useEmbeddingModel', () => ({
  useEmbeddingModel: () => state.current,
  useLocalEmbeddingModel: () => state.local,
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({
    to,
    className,
    children,
  }: {
    to: string
    className?: string
    children: React.ReactNode
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { getBaselineEmbeddingCatalog } from '@/services/embedding-catalog-registry'
import { useEmbeddingStore } from '@/stores/embedding-store'
import EmbeddingModelCard, {
  EmbeddingModelStatus,
  LocalEmbeddingModelActions,
  LocalEmbeddingModelStatus,
} from '../EmbeddingModelCard'

const model = getBaselineEmbeddingCatalog().models[0]
const local = {
  id: 'sentence-transformer-mini',
  name: 'sentence-transformer-mini',
  model_path: 'llamacpp/models/sentence-transformer-mini/model.gguf',
  mmproj_path: '',
}

const runState = (
  overrides: Partial<EmbeddingRunState>
): EmbeddingRunState => ({
  active: false,
  running: false,
  state: null,
  busy: false,
  activate: vi.fn().mockResolvedValue(true),
  stop: vi.fn().mockResolvedValue(true),
  ...overrides,
})

const modelState = (
  overrides: Partial<EmbeddingModelState>
): EmbeddingModelState => ({
  ...runState({}),
  installed: true,
  downloading: false,
  progress: 0,
  currentBytes: 0,
  totalBytes: 0,
  download: vi.fn(),
  cancelDownload: vi.fn(),
  remove: vi.fn(),
  ...overrides,
})

describe('EmbeddingModelCard', () => {
  beforeEach(() => {
    useEmbeddingStore.setState({ busy: null })
  })

  it('starts an installed model where models are run', async () => {
    state.current = modelState({})
    render(<EmbeddingModelCard model={model} />)

    await userEvent.click(
      screen.getByRole('button', { name: 'settings:embedding.start' })
    )
    expect(state.current.activate).toHaveBeenCalledOnce()
    expect(
      screen.queryByRole('button', { name: 'hub:open' })
    ).not.toBeInTheDocument()
  })

  it('goes to the API page once the model started, and stays when it did not', async () => {
    navigate.mockClear()
    state.current = modelState({})
    const { unmount } = render(<EmbeddingModelCard model={model} />)
    await userEvent.click(
      screen.getByRole('button', { name: 'settings:embedding.start' })
    )
    expect(navigate).toHaveBeenCalledWith({ to: '/api/' })
    unmount()

    navigate.mockClear()
    state.current = modelState({ activate: vi.fn().mockResolvedValue(false) })
    render(<EmbeddingModelCard model={model} />)
    await userEvent.click(
      screen.getByRole('button', { name: 'settings:embedding.start' })
    )
    expect(state.current.activate).toHaveBeenCalledOnce()
    expect(navigate).not.toHaveBeenCalled()
    // The user stays on the card, with Start offered again for another try.
    expect(
      screen.getByRole('button', { name: 'settings:embedding.start' })
    ).toBeEnabled()
  })

  it('keeps Start disabled while the engine is too old, or another call is in flight', () => {
    state.current = modelState({})
    const { rerender } = render(
      <EmbeddingModelCard model={model} startBlocked />
    )
    expect(
      screen.getByRole('button', { name: 'settings:embedding.start' })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'settings:embedding.start' })
    ).toHaveAttribute('title', 'settings:embedding.startHint')

    act(() => useEmbeddingStore.setState({ busy: 'bge-m3' }))
    rerender(<EmbeddingModelCard model={model} />)
    expect(
      screen.getByRole('button', { name: 'settings:embedding.start' })
    ).toBeDisabled()
  })

  it('turns Start into a red Stop once the model runs, as chat models do', async () => {
    state.current = modelState({ running: true, state: 'starting' })
    render(<EmbeddingModelCard model={model} />)

    const stop = screen.getByRole('button', {
      name: 'settings:embedding.stop',
    })
    expect(stop).toHaveAttribute('data-variant', 'destructive')
    // Stop turns the service off, not just the process: the tooltip says so.
    expect(stop).toHaveAttribute('title', 'settings:embedding.stopHint')
    await userEvent.click(stop)
    expect(state.current.stop).toHaveBeenCalledOnce()
  })

  it('asks before removing a model', async () => {
    state.current = modelState({})
    render(<EmbeddingModelCard model={model} />)

    await userEvent.click(
      screen.getByRole('button', { name: 'settings:embedding.remove' })
    )
    expect(
      screen.getByText('settings:embedding.removeDescription')
    ).toBeVisible()
    const buttons = screen.getAllByRole('button', {
      name: 'settings:embedding.remove',
    })
    await userEvent.click(buttons[buttons.length - 1])
    expect(state.current.remove).toHaveBeenCalledOnce()
  })

  it('offers Open and removal in place of Start once installed, given onOpen', async () => {
    state.current = modelState({ running: true, state: 'ready' })
    const onOpen = vi.fn()
    render(<EmbeddingModelCard model={model} onOpen={onOpen} />)

    await userEvent.click(screen.getByRole('button', { name: 'hub:open' }))
    expect(onOpen).toHaveBeenCalledOnce()
    expect(
      screen.getByRole('button', { name: 'settings:embedding.remove' })
    ).toBeVisible()
    expect(
      screen.queryByRole('button', {
        name: /settings:embedding\.(start|stop)/,
      })
    ).not.toBeInTheDocument()
  })

  it('downloads a model that is not on disk, and shows the progress of one that is coming', async () => {
    state.current = modelState({ installed: false })
    const { rerender } = render(
      <EmbeddingModelCard model={model} onOpen={vi.fn()} />
    )
    await userEvent.click(screen.getByRole('button', { name: 'hub:download' }))
    expect(state.current.download).toHaveBeenCalledOnce()

    state.current = modelState({
      installed: false,
      downloading: true,
      progress: 0.25,
    })
    rerender(<EmbeddingModelCard model={model} key="downloading" />)
    const cancel = screen.getByRole('button', { name: 'common:cancelDownload' })
    expect(cancel).toHaveTextContent('25%')
    await userEvent.click(cancel)
    expect(state.current.cancelDownload).toHaveBeenCalledOnce()
  })

  it('says whether a served model is loaded or idle, and that it is in the API', () => {
    state.current = modelState({ active: true, running: true, state: 'idle' })
    const { rerender } = render(<EmbeddingModelStatus model={model} />)
    const status = () => screen.getByTestId('embedding-run-status')
    expect(status()).toHaveTextContent('settings:embedding.state.idle')
    expect(
      screen.getByRole('link', { name: 'settings:embedding.availableInApi' })
    ).toHaveAttribute('href', '/api/')

    state.current = modelState({ active: true, running: true, state: 'ready' })
    rerender(<EmbeddingModelStatus model={model} key="ready" />)
    expect(status()).toHaveTextContent('settings:embedding.state.ready')
    expect(
      screen.getByRole('link', { name: 'settings:embedding.availableInApi' })
    ).toBeVisible()
  })

  it('says what a starting or failed one is doing, and that a stopped one is off', () => {
    state.current = modelState({ active: true, running: true, state: 'failed' })
    const { rerender } = render(<EmbeddingModelStatus model={model} />)
    expect(screen.getByText('settings:embedding.state.failed')).toBeVisible()

    // Stopped: requests no longer load it, and it is not in the API.
    state.current = modelState({ active: true, running: false, state: null })
    rerender(<EmbeddingModelStatus model={model} key="stopped" />)
    expect(screen.getByTestId('embedding-run-status')).toHaveTextContent(
      'settings:embedding.state.disabled'
    )
    expect(
      screen.queryByText('settings:embedding.availableInApi')
    ).not.toBeInTheDocument()

    // Another model is the service's: nothing to say about this one.
    state.current = modelState({ active: false, running: false, state: null })
    rerender(<EmbeddingModelStatus model={model} key="other" />)
    expect(
      screen.queryByText(/settings:embedding\.(availableInApi|state)/)
    ).not.toBeInTheDocument()
  })
})

describe('a llama.cpp model served as the embedding model', () => {
  beforeEach(() => {
    useEmbeddingStore.setState({ busy: null })
  })

  it('starts and stops, with no removal of its own', async () => {
    state.local = runState({})
    const { rerender } = render(<LocalEmbeddingModelActions model={local} />)
    await userEvent.click(
      screen.getByRole('button', { name: 'settings:embedding.start' })
    )
    expect(state.local.activate).toHaveBeenCalledOnce()
    expect(
      screen.queryByRole('button', { name: 'settings:embedding.remove' })
    ).not.toBeInTheDocument()

    state.local = runState({ running: true, state: 'ready' })
    rerender(<LocalEmbeddingModelActions model={local} key="running" />)
    await userEvent.click(
      screen.getByRole('button', { name: 'settings:embedding.stop' })
    )
    expect(state.local.stop).toHaveBeenCalledOnce()
  })

  it('says when it is served', () => {
    state.local = runState({ active: true, running: true, state: 'ready' })
    render(<LocalEmbeddingModelStatus model={local} />)
    expect(
      screen.getByRole('link', { name: 'settings:embedding.availableInApi' })
    ).toBeVisible()
  })
})
