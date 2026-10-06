import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))
const notifications = vi.hoisted(() => ({ notifyWhenAway: vi.fn() }))
vi.mock('@/lib/notifications', () => notifications)

import {
  useCompatibilityVerdict,
  useModelSetupDownloads,
  useModelSetupSync,
} from '@/hooks/useModelSetup'
import { useModelProvider } from '@/hooks/useModelProvider'
import { DefaultModelSetupService } from '@/services/model-setup/default'
import type { ModelSetup, ModelSetupEvent } from '@/services/model-setup/types'
import { useModelSetupStore } from '@/stores/model-setup-store'
import { seedServiceHub } from '@/test/service-hub'

const record = (stage: ModelSetup['stage'], revision: number) =>
  ({
    setup_id: 's1',
    revision,
    stage,
    request: { repo: 'o/r', file: 'f.gguf' },
    plan: { model_id: 'o/f' },
  }) as ModelSetup

class FakeService extends DefaultModelSetupService {
  handler: ((event: ModelSetupEvent) => void) | null = null
  list = vi.fn(async () => [record('downloading_model', 1)])
  checkCompatibility = vi.fn()
  unsubscribe = vi.fn()
  override isSupported() {
    return true
  }
  override subscribe(handler: (event: ModelSetupEvent) => void) {
    this.handler = handler
    return this.unsubscribe
  }
}

const URL_A = 'https://huggingface.co/o/r/resolve/main/a.gguf'

// The shared teardown drops the service hub before it unmounts; a hook that
// reads a store would re-render into the missing hub, so unmount first.
afterEach(() => cleanup())

describe('useModelSetupSync', () => {
  let service: FakeService
  const getProviders = vi.fn(async () => [])

  beforeEach(() => {
    useModelSetupStore.setState({
      setups: {},
      progress: {},
      speeds: {},
      verdicts: {},
    })
    service = new FakeService()
    seedServiceHub({
      modelSetup: service,
      providers: { getProviders } as never,
    })
    getProviders.mockClear()
  })

  it('reads the setups on attach, follows each change and stops on unmount', async () => {
    const { unmount } = renderHook(() => useModelSetupSync())
    await waitFor(() =>
      expect(useModelSetupStore.getState().setups.s1?.stage).toBe(
        'downloading_model'
      )
    )

    service.handler!({ type: 'changed', setup: record('verifying', 2) })
    expect(useModelSetupStore.getState().setups.s1.stage).toBe('verifying')
    expect(getProviders).not.toHaveBeenCalled()

    unmount()
    expect(service.unsubscribe).toHaveBeenCalled()
  })

  it('reads the providers again when a setup registers its model', async () => {
    const clearDeletedModel = vi.fn()
    useModelProvider.setState({ clearDeletedModel })
    renderHook(() => useModelSetupSync())
    await waitFor(() => expect(service.list).toHaveBeenCalled())

    getProviders.mockResolvedValueOnce([
      {
        provider: 'atomic-prism',
        active: true,
        settings: [],
        models: [{ id: 'o/f', name: 'o/f', capabilities: [], settings: {} }],
      },
    ] as never)
    service.handler!({ type: 'changed', setup: record('ready', 3) })
    service.handler!({ type: 'changed', setup: record('ready', 4) })

    await waitFor(() =>
      expect(
        useModelProvider.getState().providers.map((p) => p.provider)
      ).toContain('atomic-prism')
    )
    expect(getProviders).toHaveBeenCalledTimes(1)
    expect(clearDeletedModel).toHaveBeenCalledWith('o/f')
  })

  it('lists again when a new core generation attaches', async () => {
    renderHook(() => useModelSetupSync())
    await waitFor(() => expect(service.list).toHaveBeenCalledTimes(1))

    service.list.mockResolvedValueOnce([record('verifying', 7)])
    service.handler!({ type: 'reset' })
    await waitFor(() =>
      expect(useModelSetupStore.getState().setups.s1?.stage).toBe('verifying')
    )
  })

  describe('says how a setup it saw under way ended, as a download ends', () => {
    /** What the person was told: each toast as `kind: title`. */
    const told = () => [
      ...toast.success.mock.calls.map(([title]) => `success: ${title}`),
      ...toast.error.mock.calls.map(([title]) => `error: ${title}`),
      ...toast.info.mock.calls.map(([title]) => `info: ${title}`),
    ]

    beforeEach(() => {
      toast.success.mockClear()
      toast.error.mockClear()
      toast.info.mockClear()
      notifications.notifyWhenAway.mockClear()
    })

    const settle = async () => {
      renderHook(() => useModelSetupSync())
      await waitFor(() =>
        expect(useModelSetupStore.getState().setups.s1?.stage).toBe(
          'downloading_model'
        )
      )
    }

    it('ready: the download-complete toast and, while away, the OS notification', async () => {
      await settle()

      act(() =>
        service.handler!({ type: 'changed', setup: record('ready', 2) })
      )
      // The same ending heard again is not a second one.
      act(() =>
        service.handler!({ type: 'changed', setup: record('ready', 3) })
      )

      expect(told()).toEqual(['success: common:toast.downloadComplete.title'])
      expect(notifications.notifyWhenAway.mock.calls).toEqual([
        [
          'common:desktopNotification.modelReadyTitle',
          'common:desktopNotification.modelReadyBody',
        ],
      ])
      expect(useModelSetupStore.getState().setups.s1.stage).toBe('ready')
    })

    it('failed: the reason from the core in the download-failed toast', async () => {
      await settle()

      act(() =>
        service.handler!({
          type: 'changed',
          setup: {
            ...record('failed', 2),
            error: { code: 'DOWNLOAD_FAILED', message: 'network down' },
          },
        })
      )

      expect(told()).toEqual(['error: common:toast.downloadFailed.title'])
      const [, options] = toast.error.mock.calls[0] as unknown as [
        string,
        { description: string },
      ]
      expect(options.description).toBe('hub:prismSetupFailed')
      expect(useModelSetupStore.getState().setups.s1.error?.message).toBe(
        'network down'
      )
    })

    it('cancelled: the download-cancelled toast once, whoever applied it first', async () => {
      await settle()

      // The panel applies the record its cancel returned; the event follows.
      act(() =>
        useModelSetupStore
          .getState()
          .apply({ type: 'changed', setup: record('cancelled', 2) })
      )
      act(() =>
        service.handler!({ type: 'changed', setup: record('cancelled', 2) })
      )

      expect(told()).toEqual(['info: common:toast.downloadCancelled.title'])
      expect(useModelSetupStore.getState().setups.s1.stage).toBe('cancelled')
    })

    it('says nothing about setups that had ended before this window heard of them', async () => {
      service.list.mockResolvedValueOnce([record('ready', 1)])
      renderHook(() => useModelSetupSync())
      await waitFor(() =>
        expect(useModelSetupStore.getState().setups.s1?.stage).toBe('ready')
      )

      expect(told()).toEqual([])
      expect(notifications.notifyWhenAway.mock.calls).toEqual([])
    })
  })

  it('does nothing where there is no core', () => {
    seedServiceHub({ modelSetup: new DefaultModelSetupService() })
    renderHook(() => useModelSetupSync())
    expect(useModelSetupStore.getState().setups).toEqual({})
  })
})

describe('useModelSetupDownloads', () => {
  it('gives each setup under way its bytes and the speed of its running download', () => {
    useModelSetupStore.setState({
      setups: {
        s1: {
          ...record('downloading_model', 1),
          plan: {
            model_id: 'o/f',
            engine: null,
            model: { size: 100 },
            projector: null,
          },
          task_ids: { model: 'tm' },
        } as ModelSetup,
      },
      progress: { tm: { transferred: 40, total: 100 } },
      speeds: { tm: { bytesPerSecond: 7, atBytes: 40, atTime: 0 } },
    })

    const { result } = renderHook(() => useModelSetupDownloads())

    expect(result.current).toHaveLength(1)
    expect(result.current[0].bytes).toEqual({ transferred: 40, total: 100 })
    expect(result.current[0].bytesPerSecond).toBe(7)
  })
})

describe('useCompatibilityVerdict', () => {
  let service: FakeService

  beforeEach(() => {
    useModelSetupStore.setState({
      setups: {},
      progress: {},
      speeds: {},
      verdicts: {},
    })
    service = new FakeService()
    seedServiceHub({ modelSetup: service })
  })

  it('asks the core once per file from the rules alone', async () => {
    const answer = { outcome: 'engine_required', provider: 'atomic-prism' }
    service.checkCompatibility.mockResolvedValue(answer)

    const first = renderHook(() => useCompatibilityVerdict(URL_A))
    renderHook(() => useCompatibilityVerdict(URL_A))

    await waitFor(() => expect(first.result.current).toEqual(answer))
    expect(service.checkCompatibility).toHaveBeenCalledTimes(1)
    expect(service.checkCompatibility).toHaveBeenCalledWith({
      repo: 'o/r',
      file: 'a.gguf',
      revision: 'main',
      provider: 'llamacpp-upstream',
    })
  })

  it('remembers that the core could not say', async () => {
    service.checkCompatibility.mockRejectedValue(new Error('down'))
    const { result } = renderHook(() => useCompatibilityVerdict(URL_A))
    await waitFor(() => expect(result.current).toBeNull())
  })

  it('asks nothing for a file outside Hugging Face', () => {
    const { result } = renderHook(() =>
      useCompatibilityVerdict('https://example.test/a.gguf')
    )
    expect(result.current).toBeUndefined()
    expect(service.checkCompatibility).not.toHaveBeenCalled()
  })
})
