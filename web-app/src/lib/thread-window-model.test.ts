import { beforeEach, describe, expect, it } from 'vitest'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  restoreThreadWindowModel,
  threadWindowUrl,
} from '@/lib/thread-window-model'

const QWEN = 'Qwen2.5-0.5B-Instruct-Q4_K_M'

const provider = (name: string, active = true) =>
  ({
    provider: name,
    active,
    models: [{ id: QWEN, capabilities: ['completion'] }],
    settings: [],
  }) as unknown as ModelProvider

const locationOf = (url: string) => {
  const { pathname, search } = new URL(url, 'http://localhost')
  return { pathname, search }
}

const selection = () => {
  const { selectedProvider, selectedModel } = useModelProvider.getState()
  return { provider: selectedProvider, model: selectedModel?.id ?? null }
}

beforeEach(() => {
  localStorage.clear()
  useModelProvider.setState({
    providers: [provider('llamacpp'), provider('llamacpp-upstream')],
    selectedProvider: '',
    selectedModel: null,
  })
})

describe('threadWindowUrl', () => {
  it('opens a project task in its own agent window with the selected engine', () => {
    useModelProvider.getState().selectModelProvider('llamacpp-upstream', QWEN)
    const location = locationOf(threadWindowUrl('task-1', 'agent'))
    expect(location.pathname).toBe('/agent/task-1')
    useModelProvider.setState({ selectedModel: null, selectedProvider: '' })
    restoreThreadWindowModel(location)
    expect(selection()).toEqual({ model: QWEN, provider: 'llamacpp-upstream' })
  })

  it('opens a bare thread URL while nothing is selected', () => {
    expect(threadWindowUrl('thread-1')).toBe('/threads/thread-1')
  })

  it('carries the selected provider together with the model', () => {
    useModelProvider.getState().selectModelProvider('llamacpp-upstream', QWEN)

    const { pathname, search } = locationOf(threadWindowUrl('thread-1'))

    expect(pathname).toBe('/threads/thread-1')
    expect(
      JSON.parse(new URLSearchParams(search).get('threadModel') ?? '')
    ).toEqual({ id: QWEN, provider: 'llamacpp-upstream' })
  })
})

describe('restoreThreadWindowModel', () => {
  it('selects the provider the URL names, not the first one listing the id', () => {
    useModelProvider.getState().selectModelProvider('llamacpp-upstream', QWEN)
    const url = threadWindowUrl('thread-1')
    useModelProvider.setState({ selectedProvider: '', selectedModel: null })

    restoreThreadWindowModel(locationOf(url))

    expect(selection()).toEqual({ provider: 'llamacpp-upstream', model: QWEN })
  })

  it('leaves the selection alone when the URL names nothing usable', () => {
    useModelProvider.getState().selectModelProvider('llamacpp', QWEN)
    const model = (value: unknown) =>
      `?threadModel=${encodeURIComponent(JSON.stringify(value))}`
    useModelProvider.setState({
      providers: [provider('llamacpp'), provider('llamacpp-upstream', false)],
    })

    for (const location of [
      {
        pathname: '/',
        search: model({ id: QWEN, provider: 'llamacpp-upstream' }),
      },
      { pathname: '/threads/thread-1', search: '?threadModel=%7Bnot-json' },
      { pathname: '/threads/thread-1', search: model({ id: QWEN }) },
      {
        pathname: '/threads/thread-1',
        search: model({ id: QWEN, provider: 'llamacpp-upstream' }),
      },
      {
        pathname: '/threads/thread-1',
        search: model({ id: 'gone', provider: 'llamacpp' }),
      },
      {
        pathname: '/threads/thread-1',
        search: model({ id: QWEN, provider: 'mlx' }),
      },
    ]) {
      restoreThreadWindowModel(location)
      expect(selection()).toEqual({ provider: 'llamacpp', model: QWEN })
    }
  })
})
