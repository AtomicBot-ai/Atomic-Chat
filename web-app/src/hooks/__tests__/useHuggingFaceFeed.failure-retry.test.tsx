import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  token: undefined as string | undefined,
  fetchRepo: vi.fn(),
  convert: vi.fn((repo) => ({
    model_name: repo.modelId,
    description: '',
    downloads: 0,
    quants: [],
  })),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    models: () => ({
      fetchHuggingFaceRepo: mocks.fetchRepo,
      convertHfRepoToCatalogModel: mocks.convert,
    }),
  }),
}))
vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (
    selector: (state: { huggingfaceToken?: string }) => unknown
  ) => selector({ huggingfaceToken: mocks.token }),
}))
import {
  resetHuggingFaceFeedForTest,
  useHuggingFaceFeed,
} from '../useHuggingFaceFeed'

beforeEach(() => {
  resetHuggingFaceFeedForTest()
  mocks.token = ''
  mocks.fetchRepo.mockReset()
})

describe('failed-repository recovery', () => {
  it('fetches public repository details with the default undefined token', async () => {
    mocks.token = undefined
    mocks.fetchRepo.mockResolvedValueOnce({ modelId: 'owner/public' })
    const { result } = renderHook(() =>
      useHuggingFaceFeed('gguf', 'trending', false)
    )
    act(() => result.current.ensureDetails(['owner/public']))
    await waitFor(() =>
      expect(result.current.details.has('owner/public')).toBe(true)
    )
    expect(mocks.fetchRepo).toHaveBeenCalledWith('owner/public', undefined)
  })

  it('can resolve a previously inaccessible repo after its Hugging Face token changes', async () => {
    mocks.fetchRepo.mockResolvedValueOnce(null)
    const { result, rerender } = renderHook(() =>
      useHuggingFaceFeed('gguf', 'trending', false)
    )
    act(() => result.current.ensureDetails(['owner/chat']))
    await waitFor(() =>
      expect(result.current.detailsVersion).toBeGreaterThan(0)
    )
    mocks.token = 'replacement-token'
    mocks.fetchRepo.mockResolvedValueOnce({ modelId: 'owner/chat' })
    rerender()
    act(() => result.current.ensureDetails(['owner/chat']))
    await waitFor(() =>
      expect(result.current.details.has('owner/chat')).toBe(true)
    )
    expect(mocks.fetchRepo).toHaveBeenLastCalledWith(
      'owner/chat',
      'replacement-token'
    )
  })
  it('retries a failed card only when explicitly requested', async () => {
    mocks.fetchRepo.mockResolvedValueOnce(null)
    const { result } = renderHook(() =>
      useHuggingFaceFeed('gguf', 'trending', false)
    )
    act(() => result.current.ensureDetails(['owner/chat']))
    await waitFor(() =>
      expect(result.current.detailsVersion).toBeGreaterThan(0)
    )
    act(() => result.current.ensureDetails(['owner/chat']))
    expect(mocks.fetchRepo).toHaveBeenCalledTimes(1)
    mocks.fetchRepo.mockResolvedValueOnce({ modelId: 'owner/chat' })
    act(() => result.current.ensureDetails(['owner/chat'], true))
    await waitFor(() =>
      expect(result.current.details.has('owner/chat')).toBe(true)
    )
    expect(mocks.fetchRepo).toHaveBeenCalledTimes(2)
  })
})
