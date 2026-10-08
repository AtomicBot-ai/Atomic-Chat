import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearLegacyEngineUpdateOffers,
  isEngineUpdateSnoozed,
} from '@/lib/engineUpdateOffer'
import type { EngineId, EngineVersions } from '@/services/engines/types'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

const updateEngineWithProgress = vi.fn()
vi.mock('@/services/engines/update', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/engines/update')>()),
  updateEngineWithProgress: (...args: unknown[]) =>
    updateEngineWithProgress(...args),
}))

// The media engine's update runs through the image store, which keeps the
// Settings → Media state of it.
const imageStore = vi.hoisted(() => ({ updateEngine: vi.fn() }))
vi.mock('@/stores/image-generation-store', () => ({
  useImageGenerationStore: { getState: () => imageStore },
}))

const { useEngineUpdate } = await import('../useEngineUpdate')

const versions = (
  engine: EngineId,
  patch: Partial<EngineVersions> = {}
): EngineVersions => ({
  engine,
  kind: 'llamacpp',
  active_choice: 'client',
  builds: [],
  active: { version: 'b11400', variant: 'macos-arm64' },
  latest: { version: 'b11500', variant: 'macos-arm64' },
  update: {
    needed: true,
    target: {
      version: 'b11500',
      variant: 'macos-arm64',
      download_bytes: 42_000_000,
    },
    apply: 'swap',
  },
  source: 'remote',
  source_error: null,
  error: null,
  ...patch,
})

const hold = (...entries: EngineVersions[]) =>
  act(() => {
    useEngineVersionsStore.setState({
      engines: Object.fromEntries(entries.map((e) => [e.engine, e])),
    })
  })

describe('useEngineUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useEngineVersionsStore.getState().reset()
    updateEngineWithProgress.mockResolvedValue({
      updated: true,
      active: { version: 'b11500', variant: 'macos-arm64' },
      retired: [],
      kept_in_use: [],
    })
    imageStore.updateEngine.mockResolvedValue(undefined)
  })

  it('offers what the core says is needed, with the size from its answer', () => {
    const { result } = renderHook(() => useEngineUpdate())
    expect(result.current.offer).toBeNull()

    hold(versions('llamacpp-upstream'))

    expect(result.current.offer).toMatchObject({
      provider: 'llamacpp-upstream',
      currentVersion: 'b11400',
      targetVersion: 'b11500',
      targetBackend: 'b11500/macos-arm64',
      downloadSizeBytes: 42_000_000,
      apply: 'swap',
      releaseNotesUrl:
        'https://github.com/ggml-org/llama.cpp/releases/tag/b11500',
    })
  })

  it('never turns a blocked update into an offer', () => {
    hold(
      versions('llamacpp-upstream', {
        update: {
          needed: false,
          target: { version: 'b11500', variant: 'win-vulkan-x64' },
          apply: 'swap',
          blocked_reason: 'family-change',
        },
      })
    )
    const { result } = renderHook(() => useEngineUpdate())
    expect(result.current.offer).toBeNull()
  })

  it('keeps the engines in their order: the default llama.cpp first, the media engine after MLX', () => {
    hold(
      versions('sd-cpp', { kind: 'engine-build', active_choice: 'core' }),
      versions('mlx', { kind: 'engine-build', active_choice: 'core' }),
      versions('llamacpp')
    )
    const { result } = renderHook(() => useEngineUpdate())
    expect(result.current.offer?.provider).toBe('llamacpp')

    act(() => result.current.remindLater())
    expect(result.current.offer?.provider).toBe('mlx')
    act(() => result.current.dismiss())
    expect(result.current.offer?.provider).toBe('sd-cpp')
  })

  it('snoozes for a day and dismisses for good, per target', () => {
    hold(versions('llamacpp-upstream'))
    const { result, unmount } = renderHook(() => useEngineUpdate())
    const offer = result.current.offer!

    act(() => result.current.remindLater())
    expect(result.current.offer).toBeNull()
    expect(isEngineUpdateSnoozed(offer, Date.now())).toBe(true)
    expect(isEngineUpdateSnoozed(offer, Date.now() + 25 * 3600_000)).toBe(false)
    unmount()

    // A newer target is a new question.
    hold(
      versions('llamacpp-upstream', {
        update: {
          needed: true,
          target: { version: 'b11600', variant: 'macos-arm64' },
          apply: 'swap',
        },
      })
    )
    const again = renderHook(() => useEngineUpdate())
    expect(again.result.current.offer?.targetVersion).toBe('b11600')
    act(() => again.result.current.dismiss())
    expect(again.result.current.offer).toBeNull()
  })

  it('applies a swap through the core under the engine-update task id and takes the offer down', async () => {
    hold(versions('llamacpp-upstream'))
    const { result } = renderHook(() => useEngineUpdate())

    await act(() => result.current.applyUpdate())

    expect(updateEngineWithProgress).toHaveBeenCalledWith('llamacpp-upstream', {
      taskId: 'engine-update-llamacpp-upstream-b11500',
    })
    expect(result.current.offer).toBeNull()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('updates the media engine through the image store', async () => {
    hold(versions('sd-cpp', { kind: 'engine-build', active_choice: 'core' }))
    const { result } = renderHook(() => useEngineUpdate())

    await act(() => result.current.applyUpdate())

    expect(imageStore.updateEngine).toHaveBeenCalledTimes(1)
    expect(updateEngineWithProgress).not.toHaveBeenCalled()
    expect(result.current.offer).toBeNull()
  })

  it('opens the managed engine’s page instead of reinstalling from the banner', async () => {
    hold(
      versions('vllm', {
        kind: 'managed',
        active_choice: 'core',
        active: { version: 'vllm-0.31.0-r1', variant: 'linux/amd64' },
        update: {
          needed: true,
          target: { version: 'vllm-0.32.0-r1', variant: 'linux/amd64' },
          apply: 'reinstall',
        },
      })
    )
    const { result } = renderHook(() => useEngineUpdate())
    expect(result.current.offer?.apply).toBe('reinstall')

    await act(() => result.current.applyUpdate())

    expect(updateEngineWithProgress).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith({
      to: '/settings/providers/$providerName',
      params: { providerName: 'vllm' },
      search: { engineUpdate: true },
    })
  })

  it('brings the offer back when the core refuses the update', async () => {
    updateEngineWithProgress.mockRejectedValue({
      code: 'ENGINE_INSTALL_FAILED',
      message: 'download failed',
    })
    hold(versions('llamacpp-upstream'))
    const { result } = renderHook(() => useEngineUpdate())

    await expect(act(() => result.current.applyUpdate())).rejects.toMatchObject(
      {
        code: 'ENGINE_INSTALL_FAILED',
      }
    )
    await waitFor(() =>
      expect(result.current.offer?.targetVersion).toBe('b11500')
    )
  })
})

describe('clearLegacyEngineUpdateOffers', () => {
  it('drops only the offers earlier versions persisted', () => {
    localStorage.setItem('atomic_engine_update_offer_llamacpp-upstream', '{}')
    localStorage.setItem('atomic_engine_update_offer_sd-cpp', '{}')
    localStorage.setItem('atomic-engine-update-snooze', '{}')

    clearLegacyEngineUpdateOffers()

    expect(
      localStorage.getItem('atomic_engine_update_offer_llamacpp-upstream')
    ).toBeNull()
    expect(localStorage.getItem('atomic_engine_update_offer_sd-cpp')).toBeNull()
    expect(localStorage.getItem('atomic-engine-update-snooze')).toBe('{}')
  })
})
