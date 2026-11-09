import { expect, it, vi } from 'vitest'
import type { AIEngine } from '@janhq/core'
import { DefaultModelsService } from './default'
import { makeRoomForChatModel } from './gpuRoom'
vi.mock('./gpuRoom', () => ({ makeRoomForChatModel: vi.fn() }))

type Internals = {
  getLocalActiveModelsByProvider: () => Promise<
    Array<{ provider: string; models: string[] }>
  >
  getEngine: () => AIEngine
}
it('switches NPU models without stopping a GPU session, and preserves NPU on a GPU switch', async () => {
  const service = new DefaultModelsService()
  vi.spyOn(
    service as unknown as Internals,
    'getLocalActiveModelsByProvider'
  ).mockResolvedValue([
    { provider: 'fastflowlm', models: ['npu-old'] },
    { provider: 'llamacpp-upstream', models: ['gpu-old'] },
  ])
  const stop = vi
    .spyOn(service, 'stopModel')
    .mockResolvedValue({ success: true })
  await service.stopAllModelsExcept('npu-new', 'fastflowlm')
  expect(stop.mock.calls).toEqual([['npu-old', 'fastflowlm']])
  stop.mockClear()
  await service.stopAllModelsExcept('gpu-new', 'llamacpp-upstream')
  expect(stop.mock.calls).toEqual([['gpu-old', 'llamacpp-upstream']])
})
it('inherits FLM engine settings and never asks the GPU arbiter to make room', async () => {
  const service = new DefaultModelsService()
  const load = vi.fn().mockResolvedValue({ port: 123 })
  vi.spyOn(service as unknown as Internals, 'getEngine').mockReturnValue({
    getLoadedModels: async () => [],
    load,
  } as unknown as AIEngine)
  const provider = {
    provider: 'fastflowlm',
    models: [
      { id: 'npu', settings: { ctx_len: { controller_props: { value: 0 } } } },
    ],
  } as unknown as ProviderObject
  await service.startModel(provider, 'npu')
  expect(makeRoomForChatModel).not.toHaveBeenCalled()
  expect(load.mock.calls[0]?.[1]).toBeUndefined()
})

it('does not shadow the FLM engine context with a legacy generic model default', async () => {
  const service = new DefaultModelsService()
  const load = vi.fn().mockResolvedValue({ port: 123 })
  vi.spyOn(service as unknown as Internals, 'getEngine').mockReturnValue({
    getLoadedModels: async () => [],
    load,
  } as unknown as AIEngine)
  const provider = {
    provider: 'fastflowlm',
    settings: [{ key: 'ctx_len', controller_props: { value: 4096 } }],
    models: [
      {
        id: 'npu',
        settings: {
          ctx_len: { controller_props: { value: 16384 } },
          ngl: { controller_props: { value: 100 } },
        },
      },
    ],
  } as unknown as ProviderObject
  await service.startModel(provider, 'npu')
  expect(load.mock.calls[0]?.[1]).toBeUndefined()
})
