import { beforeEach, describe, expect, it, vi } from 'vitest'

const arbiter = vi.hoisted(() => ({
  releaseGpuForChat: vi.fn(async () => ({ unloadedDiffusion: true })),
}))
vi.mock('@/lib/diffusion/arbiter', () => arbiter)

const platform = vi.hoisted(() => ({ MEDIA_GENERATION: true }))
vi.mock('@/lib/platform/const', async () => {
  const { PlatformFeature } = await import('@/lib/platform/types')
  return {
    PlatformFeatures: new Proxy({} as Record<string, boolean>, {
      get: (_target, key) =>
        key === PlatformFeature.MEDIA_GENERATION
          ? platform.MEDIA_GENERATION
          : false,
    }),
  }
})

import { chatModelBytes, makeRoomForChatModel } from '../gpuRoom'

const engineKnowing = (sizeBytes: number | undefined) => ({
  get: vi.fn(async (id: string) =>
    id === 'known'
      ? {
          id,
          name: id,
          providerId: 'llamacpp-upstream',
          port: 0,
          sizeBytes: sizeBytes as number,
        }
      : undefined
  ),
})

describe('makeRoomForChatModel', () => {
  beforeEach(() => {
    arbiter.releaseGpuForChat.mockReset()
    arbiter.releaseGpuForChat.mockResolvedValue({ unloadedDiffusion: true })
    platform.MEDIA_GENERATION = true
  })

  it('asks the arbiter with the bytes the engine reports for the model', async () => {
    await expect(
      makeRoomForChatModel(engineKnowing(4096), 'known')
    ).resolves.toEqual({ unloadedDiffusion: true })
    expect(arbiter.releaseGpuForChat).toHaveBeenCalledWith({ modelBytes: 4096 })
  })

  it('claims an infinite size for a model whose size is unknown, which the arbiter reads as "does not fit"', async () => {
    await makeRoomForChatModel(engineKnowing(0), 'known')
    expect(arbiter.releaseGpuForChat).toHaveBeenCalledWith({
      modelBytes: Number.POSITIVE_INFINITY,
    })
    await makeRoomForChatModel(engineKnowing(4096), 'unknown')
    expect(arbiter.releaseGpuForChat).toHaveBeenLastCalledWith({
      modelBytes: Number.POSITIVE_INFINITY,
    })
  })

  it('does nothing where the platform has no image generation', async () => {
    platform.MEDIA_GENERATION = false
    await expect(
      makeRoomForChatModel(engineKnowing(4096), 'known')
    ).resolves.toEqual({ unloadedDiffusion: false })
    expect(arbiter.releaseGpuForChat).not.toHaveBeenCalled()
  })

  it('never fails the load: an arbiter that throws is logged and answered with nothing unloaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    arbiter.releaseGpuForChat.mockRejectedValue(new Error('hub down'))
    await expect(
      makeRoomForChatModel(engineKnowing(4096), 'known')
    ).resolves.toEqual({ unloadedDiffusion: false })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('known'),
      expect.any(Error)
    )
    warn.mockRestore()
  })
})

describe('chatModelBytes', () => {
  it('reads a positive finite size and nothing else', async () => {
    await expect(chatModelBytes(engineKnowing(2048), 'known')).resolves.toBe(
      2048
    )
    await expect(chatModelBytes(engineKnowing(0), 'known')).resolves.toBeNull()
    await expect(
      chatModelBytes(engineKnowing(Number.NaN), 'known')
    ).resolves.toBeNull()
    await expect(
      chatModelBytes(engineKnowing(2048), 'unknown')
    ).resolves.toBeNull()
    await expect(
      chatModelBytes(
        {
          get: vi.fn(async () => {
            throw new Error('no such engine')
          }),
        },
        'known'
      )
    ).resolves.toBeNull()
  })
})
