import { act, renderHook, cleanup } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useModelProvider } from '../useModelProvider'
import { useThreadModelSelection } from '../useThreadModelSelection'
import { useInitialMessage } from '../useInitialMessage'

const first = { id: 'first.gguf', provider: 'llamacpp-upstream' }
const second = { id: 'second.gguf', provider: 'llamacpp-upstream' }
const provider = {
  provider: first.provider,
  active: true,
  models: [{ id: first.id }, { id: second.id }],
  settings: [],
} as ModelProvider
beforeEach(() =>
  useModelProvider.setState({
    providers: [provider],
    selectedModel: { id: second.id } as Model,
    selectedProvider: second.provider,
  })
)
afterEach(cleanup)
describe('saved chat model restoration', () => {
  it('restores on entry and restores another thread on navigation', () => {
    const { rerender } = renderHook(
      ({ id, model }) => useThreadModelSelection(id, model, true),
      { initialProps: { id: 'one', model: first } }
    )
    expect(useModelProvider.getState().selectedModel?.id).toBe(first.id)
    rerender({ id: 'two', model: second })
    expect(useModelProvider.getState().selectedModel?.id).toBe(second.id)
    rerender({ id: 'one', model: first })
    expect(useModelProvider.getState().selectedModel?.id).toBe(first.id)
  })
  it('does not replace a pick after provider refresh or saved-model changes', () => {
    const { rerender } = renderHook(
      ({ model }) => useThreadModelSelection('one', model, true),
      { initialProps: { model: first } }
    )
    act(() =>
      useModelProvider
        .getState()
        .selectModelProvider(second.provider, second.id)
    )
    act(() => useModelProvider.setState({ providers: [{ ...provider }] }))
    rerender({ model: second })
    expect(useModelProvider.getState().selectedModel?.id).toBe(second.id)
  })
  it.each(['missing', 'disabled', 'disconnected'])(
    'clears the global default and warns for %s',
    (reason) => {
      const saved =
        reason === 'disconnected' ? { id: first.id, provider: 'openai' } : first
      useModelProvider.setState({
        providers:
          reason === 'missing'
            ? []
            : [
                {
                  ...provider,
                  provider: saved.provider,
                  active: reason !== 'disabled',
                },
              ],
      })
      const { result } = renderHook(() =>
        useThreadModelSelection('one', saved, true)
      )
      expect(useModelProvider.getState().selectedModel).toBeNull()
      expect(result.current).toEqual(saved)
    }
  )
  it('warns when a saved local model has missing weights', () => {
    useModelProvider.setState({
      providers: [
        { ...provider, models: [{ id: first.id, missing: true } as Model] },
      ],
    })
    const { result } = renderHook(() =>
      useThreadModelSelection('one', first, true)
    )
    expect(useModelProvider.getState().selectedModel).toBeNull()
    expect(result.current).toEqual(first)
  })
  it('waits for thread data and accepts a late model library', () => {
    useModelProvider.setState({ providers: [] })
    const { result, rerender } = renderHook(
      ({ loaded }) => useThreadModelSelection('one', first, loaded),
      { initialProps: { loaded: false } }
    )
    expect(useModelProvider.getState().selectedModel?.id).toBe(second.id)
    rerender({ loaded: true })
    expect(result.current).toEqual(first)
    act(() => useModelProvider.setState({ providers: [provider] }))
    expect(useModelProvider.getState().selectedModel?.id).toBe(first.id)
    expect(result.current).toBeUndefined()
  })
  it('does not undo a replacement chosen before a late library arrives', () => {
    useModelProvider.setState({
      providers: [{ ...provider, models: [{ id: second.id } as Model] }],
    })
    const { result } = renderHook(() =>
      useThreadModelSelection('one', first, true)
    )
    act(() =>
      useModelProvider
        .getState()
        .selectModelProvider(second.provider, second.id)
    )
    act(() => useModelProvider.setState({ providers: [provider] }))
    expect(useModelProvider.getState().selectedModel?.id).toBe(second.id)
    expect(result.current).toBeUndefined()
  })
  it('leaves model-less chats unchanged', () => {
    renderHook(() => useThreadModelSelection('one', undefined, true))
    expect(useModelProvider.getState().selectedModel?.id).toBe(second.id)
  })
  it.each([
    { id: second.id, provider: second.provider },
    { id: first.id, provider: 'mlx' },
  ])(
    'waits for the restored render before consuming an initial send from $provider/$id',
    (previous) => {
      useModelProvider.setState({
        providers: [provider, { ...provider, provider: 'mlx' }],
        selectedModel: { id: previous.id } as Model,
        selectedProvider: previous.provider,
      })
      useInitialMessage.getState().set('one', { text: 'initial prompt' })
      const blocked: Array<{
        id: string | undefined
        provider: string
        pending: boolean
      }> = []
      const sent: Array<{
        id: string | undefined
        provider: string
        text: string
      }> = []

      const { rerender } = renderHook(() => {
        useThreadModelSelection('one', first, true)
        const selectedModel = useModelProvider((state) => state.selectedModel)
        const selectedProvider = useModelProvider(
          (state) => state.selectedProvider
        )
        const consumed = useRef(false)
        // Mirrors the route's one-shot handoff: the callback uses values captured
        // during render, while restoration writes the store in a layout effect.
        useEffect(() => {
          if (consumed.current) return
          const live = useModelProvider.getState()
          if (
            selectedModel?.id !== live.selectedModel?.id ||
            selectedProvider !== live.selectedProvider
          ) {
            blocked.push({
              id: selectedModel?.id,
              provider: selectedProvider,
              pending: Boolean(useInitialMessage.getState().byThread.one),
            })
            return
          }
          const message = useInitialMessage.getState().consume('one')
          if (!message) return
          consumed.current = true
          sent.push({
            id: selectedModel?.id,
            provider: selectedProvider,
            text: message.text,
          })
        }, [selectedModel?.id, selectedProvider])
      })

      expect(blocked).toEqual([{ ...previous, pending: true }])
      expect(sent).toEqual([{ ...first, text: 'initial prompt' }])
      expect(useInitialMessage.getState().byThread.one).toBeUndefined()
      rerender()
      expect(sent).toHaveLength(1)
    }
  )
})
