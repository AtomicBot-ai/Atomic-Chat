import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  useCompatibilityVerdict,
  useModelCompatibilitySync,
  usePrismFamilies,
  usePrismHubVisible,
} from '@/hooks/useModelSetup'
import { useModelProvider } from '@/hooks/useModelProvider'
import { DefaultModelSetupService } from '@/services/model-setup/default'
import { useModelCompatibilityStore } from '@/stores/model-compatibility-store'
import { seedServiceHub } from '@/test/service-hub'

class FakeService extends DefaultModelSetupService {
  reset: (() => void) | null = null
  checkCompatibility = vi.fn()
  unsubscribe = vi.fn()
  override isSupported() {
    return true
  }
  override onCoreReset(handler: () => void) {
    this.reset = handler
    return this.unsubscribe
  }
}

const URL_A = 'https://huggingface.co/o/r/resolve/main/a.gguf'

// The shared teardown drops the service hub before it unmounts; a hook that
// reads a store would re-render into the missing hub, so unmount first.
afterEach(() => cleanup())

describe('useModelCompatibilitySync', () => {
  const verdict = { outcome: 'engine_required', provider: 'atomic-prism' }

  beforeEach(() => {
    useModelCompatibilityStore.setState({
      verdicts: { [URL_A]: verdict as never },
      families: [],
    })
  })

  it('forgets the verdicts and the families when a new core generation attaches, and stops on unmount', () => {
    const service = new FakeService()
    seedServiceHub({ modelSetup: service })
    const { unmount } = renderHook(() => useModelCompatibilitySync())
    // What an older generation said is kept until a new one attaches.
    expect(useModelCompatibilityStore.getState().verdicts[URL_A]).toBe(verdict)

    service.reset!()

    expect(useModelCompatibilityStore.getState()).toMatchObject({
      verdicts: {},
      families: null,
    })
    unmount()
    expect(service.unsubscribe).toHaveBeenCalled()
  })

  it('hears nothing where there is no core', () => {
    seedServiceHub({ modelSetup: new DefaultModelSetupService() })
    renderHook(() => useModelCompatibilitySync())
    expect(useModelCompatibilityStore.getState().verdicts[URL_A]).toBe(verdict)
  })
})

describe('useCompatibilityVerdict', () => {
  let service: FakeService

  beforeEach(() => {
    useModelCompatibilityStore.setState({ verdicts: {} })
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

describe("the Hub's PrismML list", () => {
  const FAMILY = {
    id: 'bonsai-8b',
    title: 'Bonsai 8B',
    repo: 'prism-ml/Bonsai-8B-gguf',
    revision: 'abc',
    files: [
      {
        file: 'Bonsai-8B-PQ2_0.gguf',
        size: 2 * 1024 ** 3,
        sha256: 'a'.repeat(64),
        treatment: 'prism_required' as const,
      },
    ],
    projectors: [],
  }

  class FamiliesService extends DefaultModelSetupService {
    families = vi.fn(async () => ({ rules_version: 1, families: [FAMILY] }))
    override isSupported() {
      return true
    }
  }

  beforeEach(() => {
    useModelCompatibilityStore.setState({ families: null })
  })

  it('asks the core once for every list that shows it, and makes cards of the answer', async () => {
    const service = new FamiliesService()
    seedServiceHub({ modelSetup: service })

    const first = renderHook(() => usePrismFamilies(true))
    renderHook(() => usePrismFamilies(true))
    expect(first.result.current.loading).toBe(true)

    await waitFor(() => expect(first.result.current.loading).toBe(false))
    expect(first.result.current.models.map((m) => m.model_name)).toEqual([
      'prism-ml/Bonsai-8B-gguf',
    ])
    expect(service.families.mock.calls).toHaveLength(1)
  })

  it('asks nothing while the list is not shown', () => {
    const service = new FamiliesService()
    seedServiceHub({ modelSetup: service })

    const { result } = renderHook(() => usePrismFamilies(false))

    expect(result.current).toEqual({ models: [], loading: false })
    expect(service.families.mock.calls).toHaveLength(0)
  })

  it('lists nothing where there is no core, or when the core could not answer', async () => {
    seedServiceHub({ modelSetup: new DefaultModelSetupService() })
    const without = renderHook(() => usePrismFamilies(true))
    await waitFor(() => expect(without.result.current.loading).toBe(false))
    expect(without.result.current.models).toEqual([])
    cleanup()

    useModelCompatibilityStore.setState({ families: null })
    const failing = new FamiliesService()
    failing.families.mockRejectedValueOnce(new Error('core restarting'))
    seedServiceHub({ modelSetup: failing })
    const broken = renderHook(() => usePrismFamilies(true))
    await waitFor(() => expect(broken.result.current.loading).toBe(false))
    expect(broken.result.current.models).toEqual([])
  })

  it('is offered where the PrismML provider is shown', () => {
    useModelProvider.setState({
      providers: [{ provider: 'atomic-prism' }] as never,
    })
    expect(renderHook(() => usePrismHubVisible()).result.current).toBe(true)

    useModelProvider.setState({ providers: [{ provider: 'mlx' }] as never })
    expect(renderHook(() => usePrismHubVisible()).result.current).toBe(false)
  })
})
