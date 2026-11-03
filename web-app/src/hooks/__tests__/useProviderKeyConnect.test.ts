import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

const mocks = vi.hoisted(() => ({
  updateProvider: vi.fn(),
  checkProviderEndpoint: vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: () => ({ updateProvider: mocks.updateProvider }),
}))

import { seedServiceHub } from '@/test/service-hub'
import {
  keyStatusFor,
  useProviderKeyStatusStore,
} from '@/stores/provider-key-status-store'

import { useProviderKeyConnect } from '../useProviderKeyConnect'

const openai = (): ModelProvider =>
  ({
    active: true,
    provider: 'openai',
    api_key: '',
    base_url: 'https://api.openai.com/v1',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description: '',
        controller_type: 'input',
        controller_props: { value: '' },
      },
    ],
    models: [{ id: 'gpt-5.5' }],
  }) as ModelProvider

const refused = {
  ok: false,
  latencyMs: 70,
  modelCount: 0,
  httpStatus: 401,
  message: 'Authentication failed for OpenAI.',
}
const verified = { ok: true, latencyMs: 90, modelCount: 12 }
const offline = {
  ok: false,
  latencyMs: 8000,
  modelCount: 0,
  message: 'Cannot connect to OpenAI.',
}

const statusOf = (apiKey: string) =>
  keyStatusFor(
    { provider: 'openai', api_key: apiKey },
    useProviderKeyStatusStore.getState().statuses
  )?.state

describe('useProviderKeyConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useProviderKeyStatusStore.setState({ statuses: {} })
    seedServiceHub({
      providers: {
        checkProviderEndpoint: mocks.checkProviderEndpoint,
        updateSettings: vi.fn().mockResolvedValue(undefined),
      } as never,
    })
  })

  it('saves a key the provider accepts, as connected', async () => {
    mocks.checkProviderEndpoint.mockResolvedValue(verified)
    const { result } = renderHook(() =>
      useProviderKeyConnect({ duringOnboarding: true })
    )

    let outcome: Awaited<ReturnType<typeof result.current.connect>>
    await act(async () => {
      outcome = await result.current.connect(openai(), '  sk-good  ')
    })

    expect(outcome!).toEqual({
      kind: 'saved',
      providerName: 'openai',
      modelId: 'gpt-5.5',
      unverifiedReason: undefined,
    })
    expect(mocks.updateProvider.mock.calls[0][1]).toMatchObject({
      api_key: 'sk-good',
      active: true,
    })
    expect(statusOf('sk-good')).toBeUndefined()
  })

  it('does not save a refused key, then saves the same key anyway as unverified', async () => {
    mocks.checkProviderEndpoint.mockResolvedValue(refused)
    const { result } = renderHook(() =>
      useProviderKeyConnect({ duringOnboarding: true })
    )

    await act(async () => {
      expect(await result.current.connect(openai(), 'sk-bad')).toEqual({
        kind: 'notSaved',
      })
    })
    expect(result.current.keyError).toBe(
      'setup:cloudStep.keyRejected Authentication failed for OpenAI.'
    )
    expect(result.current.canSaveAnyway('sk-bad')).toBe(true)
    expect(result.current.canSaveAnyway('sk-other')).toBe(false)
    expect(mocks.updateProvider).not.toHaveBeenCalled()

    await act(async () => {
      const outcome = await result.current.connect(openai(), 'sk-bad', true)
      expect(outcome).toMatchObject({
        kind: 'saved',
        unverifiedReason:
          'setup:cloudStep.keyRejected Authentication failed for OpenAI.',
      })
    })
    expect(mocks.checkProviderEndpoint).toHaveBeenCalledTimes(1)
    expect(statusOf('sk-bad')).toBe('unverified')
    expect(result.current.keyError).toBeNull()
  })

  it('saves a key it could not check, and says why', async () => {
    mocks.checkProviderEndpoint.mockResolvedValue(offline)
    const { result } = renderHook(() =>
      useProviderKeyConnect({ duringOnboarding: false })
    )

    await act(async () => {
      expect(
        await result.current.connect(openai(), 'sk-offline')
      ).toMatchObject({
        kind: 'saved',
        unverifiedReason: 'Cannot connect to OpenAI.',
      })
    })
    expect(statusOf('sk-offline')).toBe('unverified')
  })

  it('reports a failed save and keeps nothing', async () => {
    mocks.checkProviderEndpoint.mockResolvedValue(verified)
    mocks.updateProvider.mockImplementation(() => {
      throw new Error('storage full')
    })
    const { result } = renderHook(() =>
      useProviderKeyConnect({ duringOnboarding: true })
    )

    await act(async () => {
      expect(await result.current.connect(openai(), 'sk-good')).toEqual({
        kind: 'notSaved',
      })
    })
    expect(toast.error).toHaveBeenCalledWith('setup:cloudStep.saveFailed')
  })

  it('ignores an empty key', async () => {
    const { result } = renderHook(() =>
      useProviderKeyConnect({ duringOnboarding: true })
    )

    await act(async () => {
      expect(await result.current.connect(openai(), '   ')).toEqual({
        kind: 'notSaved',
      })
    })
    expect(mocks.checkProviderEndpoint).not.toHaveBeenCalled()
  })
})
