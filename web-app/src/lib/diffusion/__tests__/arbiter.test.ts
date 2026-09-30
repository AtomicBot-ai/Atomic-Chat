import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineManager, type AIEngine } from '@janhq/core'

import { EMBEDDING_MODEL_ID } from '@/constants/models'
import { VOICE_MODEL_ID } from '@/constants/voice'
import { useHardware } from '@/hooks/useHardware'
import { seedServiceHub } from '@/test/service-hub'
import type { DiffusionService, DiffusionStatus } from '@/services/diffusion/types'

import {
  acquireGpuForDiffusion,
  noteDiffusionUnloaded,
  releaseGpuForChat,
  wouldCoexist,
} from '../arbiter'

const GIB = 1024 ** 3

type Loaded = { id: string; sizeBytes?: number; embedding?: boolean }

/** A minimal engine: enough of `AIEngine` for the arbiter, backed by a list. */
function fakeEngine(provider: string, loaded: Loaded[], log: string[]) {
  const sessions = new Map(loaded.map((m) => [m.id, m]))
  const engine = {
    provider,
    getLoadedModels: async () => [...sessions.keys()],
    get: async (id: string) => {
      const model = sessions.get(id)
      if (!model) return undefined
      return {
        id,
        name: id,
        providerId: provider,
        port: 0,
        sizeBytes: model.sizeBytes ?? 0,
        embedding: model.embedding,
      }
    },
    unload: async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      sessions.delete(id)
      log.push(`${provider}:${id}`)
      return { success: true }
    },
  }
  return { engine: engine as unknown as AIEngine, sessions }
}

const pcWith = (vramMib: number) =>
  useHardware.setState({
    hardwareData: {
      cpu: { arch: 'x86_64', core_count: 8, extensions: [], name: 'cpu', usage: 0 },
      gpus: [
        {
          name: 'gpu',
          total_memory: vramMib,
          vendor: 'NVIDIA',
          uuid: 'gpu-0',
          driver_version: '',
          nvidia_info: { index: 0, compute_capability: '' },
          vulkan_info: { index: 0, device_id: 0, device_type: '', api_version: '' },
        },
      ],
      os_type: 'windows',
      os_name: 'Windows',
      total_memory: 65536,
    },
  })

describe('acquireGpuForDiffusion', () => {
  let log: string[]
  let manager: EngineManager

  beforeEach(() => {
    log = []
    manager = new EngineManager()
    ;(window as unknown as { core: Record<string, unknown> }).core = {
      ...((window as unknown as { core?: Record<string, unknown> }).core ?? {}),
      engineManager: manager,
    }
    pcWith(16 * 1024)
    noteDiffusionUnloaded()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('evicts every chat session on every engine, keeps embeddings and voice', async () => {
    const upstream = fakeEngine(
      'llamacpp-upstream',
      [
        { id: 'chat-a', sizeBytes: 4 * GIB },
        { id: EMBEDDING_MODEL_ID, sizeBytes: 100 },
        { id: VOICE_MODEL_ID, sizeBytes: 3 * GIB },
      ],
      log
    )
    const mlx = fakeEngine('mlx', [{ id: 'chat-b', sizeBytes: 2 * GIB }], log)
    manager.register(upstream.engine)
    manager.register(mlx.engine)

    const result = await acquireGpuForDiffusion({
      requiredBytes: 6 * GIB,
      policy: 'always',
    })

    expect(result.evicted.sort()).toEqual(['chat-a', 'chat-b'])
    expect([...upstream.sessions.keys()]).toEqual([EMBEDDING_MODEL_ID, VOICE_MODEL_ID])
    expect([...mlx.sessions.keys()]).toEqual([])
  })

  it('leaves a chat model alone when both fit side by side', async () => {
    const upstream = fakeEngine('llamacpp-upstream', [{ id: 'small', sizeBytes: 3 * GIB }], log)
    manager.register(upstream.engine)

    // 3 + 6 = 9 GiB of a 16 GiB card at the 90 % coexist line.
    const result = await acquireGpuForDiffusion({
      requiredBytes: 6 * GIB,
      policy: 'whenNeeded',
    })

    expect(result.evicted).toEqual([])
    expect([...upstream.sessions.keys()]).toEqual(['small'])
  })

  it('evicts a chat model that would not fit, and one whose size is unknown', async () => {
    const upstream = fakeEngine(
      'llamacpp-upstream',
      [
        { id: 'big', sizeBytes: 10 * GIB },
        { id: 'mystery' },
      ],
      log
    )
    manager.register(upstream.engine)

    const result = await acquireGpuForDiffusion({
      requiredBytes: 6 * GIB,
      policy: 'whenNeeded',
    })

    expect(result.evicted.sort()).toEqual(['big', 'mystery'])
    expect(upstream.sessions.size).toBe(0)
  })

  it('unloads the voice model only when it is still in the way', async () => {
    const upstream = fakeEngine(
      'llamacpp-upstream',
      [
        { id: 'chat', sizeBytes: 8 * GIB },
        { id: VOICE_MODEL_ID, sizeBytes: 3 * GIB },
      ],
      log
    )
    manager.register(upstream.engine)

    // 13 GiB needed + 3 GiB voice = 16 GiB > 14.4 GiB: voice has to go too.
    const result = await acquireGpuForDiffusion({
      requiredBytes: 13 * GIB,
      policy: 'whenNeeded',
    })

    expect(result.evicted.sort()).toEqual(['chat', VOICE_MODEL_ID])
    expect(upstream.sessions.size).toBe(0)
  })

  it('keeps the voice model on request even when it is in the way', async () => {
    const upstream = fakeEngine(
      'llamacpp-upstream',
      [{ id: VOICE_MODEL_ID, sizeBytes: 3 * GIB }],
      log
    )
    manager.register(upstream.engine)

    const result = await acquireGpuForDiffusion({
      requiredBytes: 13 * GIB,
      policy: 'always',
      keepVoiceModel: true,
    })

    expect(result.evicted).toEqual([])
    expect([...upstream.sessions.keys()]).toEqual([VOICE_MODEL_ID])
  })

  it('treats unknown hardware as "does not fit"', async () => {
    useHardware.setState({
      hardwareData: {
        cpu: { arch: '', core_count: 0, extensions: [], name: '', usage: 0 },
        gpus: [],
        os_type: '',
        os_name: '',
        total_memory: 0,
      },
    })
    const upstream = fakeEngine('llamacpp-upstream', [{ id: 'chat', sizeBytes: GIB }], log)
    manager.register(upstream.engine)

    const result = await acquireGpuForDiffusion({
      requiredBytes: GIB,
      policy: 'whenNeeded',
    })

    expect(result.evicted).toEqual(['chat'])
  })

  it('serialises concurrent acquisitions', async () => {
    const upstream = fakeEngine(
      'llamacpp-upstream',
      [
        { id: 'one', sizeBytes: 10 * GIB },
        { id: 'two', sizeBytes: 10 * GIB },
      ],
      log
    )
    manager.register(upstream.engine)

    const [first, second] = await Promise.all([
      acquireGpuForDiffusion({ requiredBytes: 6 * GIB, policy: 'always' }),
      acquireGpuForDiffusion({ requiredBytes: 6 * GIB, policy: 'always' }),
    ])

    // The second call ran after the first finished: nothing was left to evict.
    expect(first.evicted.sort()).toEqual(['one', 'two'])
    expect(second.evicted).toEqual([])
    expect(log).toHaveLength(2)
  })

  it('survives an engine that cannot list its sessions', async () => {
    const broken = {
      provider: 'broken',
      getLoadedModels: async () => {
        throw new Error('no server')
      },
    } as unknown as AIEngine
    const upstream = fakeEngine('llamacpp-upstream', [{ id: 'chat', sizeBytes: GIB }], log)
    manager.register(broken)
    manager.register(upstream.engine)

    const result = await acquireGpuForDiffusion({ requiredBytes: GIB, policy: 'always' })
    expect(result.evicted).toEqual(['chat'])
  })
})

describe('releaseGpuForChat', () => {
  const status = (state: DiffusionStatus['model']['state']): DiffusionStatus => ({
    configured: true,
    install: { state: 'not-installed' },
    model: { state, loaded: null },
    activeJob: null,
    outputDir: '/data/images',
    idleUnloadSecs: 600,
  })

  let unloads: number

  beforeEach(() => {
    unloads = 0
    ;(window as unknown as { core: Record<string, unknown> }).core = {
      engineManager: new EngineManager(),
    }
    pcWith(16 * 1024)
    noteDiffusionUnloaded()
  })

  const seed = (state: DiffusionStatus['model']['state'], supported = true) =>
    seedServiceHub({
      diffusion: {
        isSupported: () => supported,
        getStatus: async () => status(state),
        unloadModel: async () => {
          unloads += 1
        },
      } as unknown as DiffusionService,
    })

  it('does nothing when no diffusion session is resident', async () => {
    seed('unloaded')
    await expect(releaseGpuForChat({ modelBytes: 8 * GIB })).resolves.toEqual({
      unloadedDiffusion: false,
    })
    expect(unloads).toBe(0)
  })

  it('unloads the diffusion session when the chat model would not fit beside it', async () => {
    seed('loaded')
    await acquireGpuForDiffusion({ requiredBytes: 8 * GIB, policy: 'always' })

    // 8 + 8 = 16 GiB > 14.4 GiB.
    await expect(releaseGpuForChat({ modelBytes: 8 * GIB })).resolves.toEqual({
      unloadedDiffusion: true,
    })
    expect(unloads).toBe(1)
  })

  it('keeps the diffusion session when both fit', async () => {
    seed('loaded')
    await acquireGpuForDiffusion({ requiredBytes: 4 * GIB, policy: 'always' })

    await expect(releaseGpuForChat({ modelBytes: 4 * GIB })).resolves.toEqual({
      unloadedDiffusion: false,
    })
    expect(unloads).toBe(0)
  })

  it('unloads when the resident size is unknown', async () => {
    seed('loaded')
    await expect(releaseGpuForChat({ modelBytes: GIB })).resolves.toEqual({
      unloadedDiffusion: true,
    })
  })

  it('is a no-op off the desktop', async () => {
    seed('loaded', false)
    await expect(releaseGpuForChat({ modelBytes: GIB })).resolves.toEqual({
      unloadedDiffusion: false,
    })
    expect(unloads).toBe(0)
  })
})

describe('wouldCoexist', () => {
  const profile = {
    tier: 'vram_16' as const,
    memoryKind: 'vram' as const,
    budgetMib: 16 * 1024,
    systemRamMib: 65536,
    vramMib: 16 * 1024,
    hardCeiling: false,
  }

  it('allows up to 90 % of a card and 85 % of a Mac', () => {
    // 90 % of 16 GiB is 14.4 GiB; 85 % is 13.6 GiB.
    expect(wouldCoexist(14 * GIB, profile)).toBe(true)
    expect(wouldCoexist(15 * GIB, profile)).toBe(false)
    expect(wouldCoexist(13 * GIB, { ...profile, hardCeiling: true })).toBe(true)
    expect(wouldCoexist(14 * GIB, { ...profile, hardCeiling: true })).toBe(false)
  })

  it('never coexists with an unknown size or unknown hardware', () => {
    expect(wouldCoexist(null, profile)).toBe(false)
    expect(wouldCoexist(GIB, null)).toBe(false)
  })
})
