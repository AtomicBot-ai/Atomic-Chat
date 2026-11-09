import { expect, it, vi } from 'vitest'
import type { AIEngine } from '@janhq/core'
import { TauriProvidersService } from './tauri'
import { DefaultModelsService } from '@/services/models/default'
const registry = vi.hoisted(() => ({ engines: new Map<string, unknown>() }))
vi.mock('@janhq/core', async (original) => ({
  ...(await original<object>()),
  EngineManager: { instance: () => ({ engines: registry.engines }) },
}))
vi.mock('@/stores/provider-registry-store', async (original) => ({
  ...(await original<object>()),
  ensureRegistryLoaded: vi.fn(async () => []),
}))
it.each([0, 4096])(
  'review: a fresh FLM model inherits engine context %s without a synthetic override',
  async (context) => {
    const load = vi.fn(
      async (_id: string, overrides?: Record<string, unknown>) => ({
        port: 123,
        context: { ctx_len: context, ...overrides }.ctx_len,
      })
    )
    const engine = {
      list: async () => [{ id: 'npu', capabilities: ['tools'] }],
      getSettings: async () => [
        {
          key: 'ctx_len',
          controllerType: 'input',
          controllerProps: { value: context },
        },
      ],
      getReasoningControls: async () => ({ supported: false }),
      getLoadedModels: async () => [],
      load,
    }
    registry.engines = new Map([['fastflowlm', engine]])
    const provider = (await new TauriProvidersService().getProviders()).find(
      (entry) => entry.provider === 'fastflowlm'
    )!
    expect(provider.models[0]?.settings).not.toHaveProperty('ctx_len')
    const models = new DefaultModelsService()
    vi.spyOn(
      models as unknown as { getEngine: () => AIEngine },
      'getEngine'
    ).mockReturnValue(engine as unknown as AIEngine)
    const session = await models.startModel(
      provider as unknown as ProviderObject,
      'npu'
    )
    expect(session).toMatchObject({ context })
  }
)

it('publishes FLM settings while its model readiness scan is still pending', async () => {
  let finish!: (models: unknown[]) => void
  const settings = vi.fn(async () => [
    { key: 'ctx_len', controllerProps: { value: 0 } },
  ])
  registry.engines = new Map([
    [
      'fastflowlm',
      {
        list: () =>
          new Promise((resolve) => {
            finish = resolve
          }),
        getSettings: settings,
      },
    ],
  ])
  const publish = vi.fn()
  const providers = new TauriProvidersService().getProviders(publish)
  await vi.waitFor(() =>
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'fastflowlm',
        models: [],
        settings: [expect.objectContaining({ key: 'ctx_len' })],
      })
    )
  )
  finish([])
  await providers
})

it('does not overwrite FLM settings edited while its model scan was pending', async () => {
  let finish!: (models: unknown[]) => void
  let context = 0
  registry.engines = new Map([
    [
      'fastflowlm',
      {
        list: () =>
          new Promise((resolve) => {
            finish = resolve
          }),
        getSettings: async () => [
          { key: 'ctx_len', controllerProps: { value: context } },
        ],
      },
    ],
  ])
  const publish = vi.fn()
  const providers = new TauriProvidersService().getProviders(publish)
  await vi.waitFor(() => expect(publish).toHaveBeenCalled())
  context = 4096
  finish([])
  expect(
    (await providers).find((p) => p.provider === 'fastflowlm')?.settings[0]
      .controller_props.value
  ).toBe(4096)
})

it('publishes FLM settings even while an earlier engine has not completed discovery', async () => {
  registry.engines = new Map([
    [
      'llamacpp-upstream',
      { getSettings: async () => [], list: () => new Promise(() => {}) },
    ],
    [
      'fastflowlm',
      {
        getSettings: async () => [
          { key: 'ctx_len', controllerProps: { value: 0 } },
        ],
        list: async () => [],
      },
    ],
  ])
  const publish = vi.fn()
  void new TauriProvidersService().getProviders(publish)
  await vi.waitFor(() =>
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'fastflowlm',
        settings: [expect.objectContaining({ key: 'ctx_len' })],
      })
    )
  )
})

it('does not return an older FLM discovery after a newer refresh has completed', async () => {
  let finishOld!: (models: unknown[]) => void
  const flmList = vi
    .fn()
    .mockResolvedValueOnce([
      { id: 'stale', capabilities: ['tools'], embedding: true },
    ])
    .mockResolvedValueOnce([
      { id: 'fresh', capabilities: ['tools'], embedding: true },
    ])
  const otherList = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve
        })
    )
    .mockResolvedValueOnce([])
  registry.engines = new Map([
    ['fastflowlm', { list: flmList, getSettings: async () => [] }],
    ['llamacpp-upstream', { list: otherList, getSettings: async () => [] }],
  ])
  const service = new TauriProvidersService()
  const old = service.getProviders()
  await vi.waitFor(() => expect(otherList).toHaveBeenCalledTimes(1))
  const fresh = await service.getProviders()
  finishOld([])
  expect((await old).find((p) => p.provider === 'fastflowlm')?.models).toEqual(
    fresh.find((p) => p.provider === 'fastflowlm')?.models
  )
})
