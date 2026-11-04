import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  useReplyModelAutoStart,
  useReplyModelPreview,
} from '@/hooks/useReplyModelAutoStart'
import { useModelProvider } from '@/hooks/useModelProvider'
import { localStorageKey } from '@/constants/localStorage'
import { seedServiceHub } from '@/test/service-hub'

const mocks = vi.hoisted(() => ({
  switchToModel: vi.fn(),
  captureAutoResolved: vi.fn(),
}))

vi.mock('@/utils/switchModel', () => ({
  switchToModel: mocks.switchToModel,
}))
vi.mock('@/lib/reply-gate-telemetry', () => ({
  captureReplyModelAutoResolved: mocks.captureAutoResolved,
}))
vi.mock('@/hooks/useHardwareTier', () => ({
  useHardwareTier: () => ({ tier: 'standard', profile: null, ready: true }),
}))

const model = (id: string) => ({ id, capabilities: [], settings: {} }) as Model
const local = (ids: string[]) =>
  ({
    provider: 'llamacpp-upstream',
    active: true,
    models: ids.map(model),
    settings: [],
  }) as ModelProvider

describe('useReplyModelPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.switchToModel.mockResolvedValue(undefined)
    seedServiceHub()
    useModelProvider.setState({
      providers: [local(['Qwen3.5-9B-Q4_K_M', 'Qwen3.5-4B-Q4_K_M'])],
      selectedProvider: '',
      selectedModel: null,
    })
  })

  afterEach(() => {
    localStorage.removeItem(localStorageKey.lastUsedModel)
  })

  // AC-02: the Send button's label reads the preview, the click runs
  // tryAutoStart. The two must name the same model.
  it.each([
    { lastUsed: null, expected: 'Qwen3.5-4B-Q4_K_M' },
    {
      lastUsed: { provider: 'llamacpp-upstream', model: 'Qwen3.5-9B-Q4_K_M' },
      expected: 'Qwen3.5-9B-Q4_K_M',
    },
  ])(
    'previews the model tryAutoStart starts (last used: $lastUsed.model)',
    ({ lastUsed, expected }) => {
      if (lastUsed) {
        localStorage.setItem(
          localStorageKey.lastUsedModel,
          JSON.stringify(lastUsed)
        )
      }
      const preview = renderHook(() => useReplyModelPreview()).result.current
      expect(preview?.option.modelId).toBe(expected)
      // Previewing selected, started and reported nothing.
      expect(useModelProvider.getState().selectedModel).toBeNull()
      expect(mocks.switchToModel).not.toHaveBeenCalled()
      expect(mocks.captureAutoResolved).not.toHaveBeenCalled()

      // Unmounted before the suite's teardown clears the service hub, which
      // a still-mounted hook would re-render against and throw on.
      const autoStart = renderHook(() => useReplyModelAutoStart())
      const { tryAutoStart } = autoStart.result.current
      let started: ReturnType<typeof tryAutoStart> = null
      act(() => {
        started = tryAutoStart()
      })
      expect(started).toMatchObject({
        resolution: preview!.resolution,
        modelLabel: preview!.option.label,
      })
      expect(useModelProvider.getState().selectedModel?.id).toBe(expected)
      expect(mocks.switchToModel).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: expected,
          providerName: 'llamacpp-upstream',
        })
      )
      autoStart.unmount()
    }
  )

  it('previews nothing when nothing would start, and nothing while disabled', () => {
    useModelProvider.setState({ providers: [local([])] })
    expect(renderHook(() => useReplyModelPreview()).result.current).toBeNull()

    useModelProvider.setState({ providers: [local(['Qwen3.5-4B-Q4_K_M'])] })
    expect(
      renderHook(() => useReplyModelPreview(false)).result.current
    ).toBeNull()
  })

  it('follows the provider list', () => {
    useModelProvider.setState({ providers: [local([])] })
    const { result } = renderHook(() => useReplyModelPreview())
    expect(result.current).toBeNull()

    act(() => {
      useModelProvider.setState({
        providers: [local(['LFM2.5-1.2B-Q4_K_M'])],
      })
    })
    expect(result.current?.option.modelId).toBe('LFM2.5-1.2B-Q4_K_M')
  })
})
