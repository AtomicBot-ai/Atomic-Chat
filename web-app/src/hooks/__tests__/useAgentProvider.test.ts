import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useAgentProvider } from '../useAgentProvider'
import { useModelProvider } from '../useModelProvider'

const provider = (name: string, apiKey = ''): ModelProvider =>
  ({
    active: true,
    provider: name,
    api_key: apiKey,
    base_url: '',
    models: [],
    settings: [],
  }) as ModelProvider

describe('useAgentProvider', () => {
  beforeEach(() => {
    useModelProvider.setState({ providers: [], selectedProvider: 'mlx' })
  })

  /**
   * The regression this hook exists for: `providers` is empty on the first
   * render because it loads asynchronously. Resolving the provider outside a
   * selector subscribes only to `selectedProvider`, so the Agent toggle would
   * stay disabled even after the providers arrive.
   */
  it('re-resolves once providers finish loading', () => {
    const { result } = renderHook(() => useAgentProvider())
    expect(result.current).toBeUndefined()

    act(() => {
      useModelProvider.setState({ providers: [provider('mlx')] })
    })

    expect(result.current?.provider).toBe('mlx')
  })

  it('follows a provider switch', () => {
    useModelProvider.setState({
      providers: [provider('mlx'), provider('openai', 'sk-test')],
      selectedProvider: 'mlx',
    })
    const { result } = renderHook(() => useAgentProvider())
    expect(result.current?.provider).toBe('mlx')

    act(() => {
      useModelProvider.setState({ selectedProvider: 'openai' })
    })

    expect(result.current?.provider).toBe('openai')
  })

  it('picks up a key saved on the selected provider', () => {
    useModelProvider.setState({
      providers: [provider('openai')],
      selectedProvider: 'openai',
    })
    const { result } = renderHook(() => useAgentProvider())
    expect(result.current?.api_key).toBe('')

    act(() => {
      useModelProvider.setState({ providers: [provider('openai', 'sk-test')] })
    })

    expect(result.current?.api_key).toBe('sk-test')
  })

  it('is undefined when the selected provider is not registered', () => {
    useModelProvider.setState({
      providers: [provider('mlx')],
      selectedProvider: 'not-installed',
    })
    const { result } = renderHook(() => useAgentProvider())
    expect(result.current).toBeUndefined()
  })
})
