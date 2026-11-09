import { describe, expect, it, vi } from 'vitest'
import { atomicModelCatalogBaseline, events } from '@janhq/core'
import { fastFlowLmModels } from './catalog'
import { invoke } from '@tauri-apps/api/core'
import { prepareFastFlowLmInstall, installFastFlowLm } from './install'

const progressListener = vi.hoisted(() => ({
  handler: undefined as
    | ((event: {
        payload: {
          transferred: number
          total: number
          stage?: { kind: string; attempt: number; maxAttempts: number }
        }
      }) => void)
    | undefined,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event, handler) => {
    progressListener.handler = handler
    return () => {}
  }),
}))

describe('FastFlowLM immutable installer plan', () => {
  it('pins every file and builds native config using the SDK before transfer', async () => {
    const model = fastFlowLmModels(atomicModelCatalogBaseline())[0]!
    const plan = await prepareFastFlowLmInstall(model, 'install-1')
    expect(plan.descriptor.files).toEqual(model.files)
    expect(plan.descriptor.sources).toEqual(model.sources)
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.config.modelInfo[model.checkpoint]).toHaveLength(
      model.files.length
    )
    expect(plan.total_bytes).toBe(
      model.files.reduce((sum, file) => sum + file.size, 0)
    )
    expect(JSON.stringify(plan)).not.toContain('Authorization')
  })

  it('refuses mutable revisions and a mismatched variant before saving anything', async () => {
    const model = structuredClone(
      fastFlowLmModels(atomicModelCatalogBaseline())[0]!
    )
    model.sources[0]!.revision = 'main'
    await expect(prepareFastFlowLmInstall(model, 'install-2')).rejects.toThrow(
      'immutable source'
    )
  })
})

it('Resume uses its original durable plan after conf changes, with credentials only in the invocation', async () => {
  const model = structuredClone(
    fastFlowLmModels(atomicModelCatalogBaseline())[0]!
  )
  const original = await prepareFastFlowLmInstall(model, 'original-request')
  const changed = structuredClone(model)
  changed.sources[0]!.revision = 'd'.repeat(40)
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'atomic_fastflowlm_install_jobs'
      ? [{ model_id: model.variant_id, state: 'downloading', plan: original }]
      : {}
  )
  await installFastFlowLm(changed, 'private-test-token')
  expect(invoke).toHaveBeenCalledWith(
    'atomic_fastflowlm_install_model',
    expect.objectContaining({
      plan: original,
      headers: { Authorization: 'Bearer private-test-token' },
    })
  )
  expect(JSON.stringify(original)).not.toContain('private-test-token')
})

it('review: forwards a retry stage without resetting the last byte progress', async () => {
  const model = fastFlowLmModels(atomicModelCatalogBaseline())[0]!
  const stage = { kind: 'retrying', attempt: 2, maxAttempts: 5 }
  const seen = vi.spyOn(events, 'emit')
  const onProgress = vi.fn()
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'atomic_fastflowlm_install_jobs') return []
    progressListener.handler!({ payload: { transferred: 50, total: 100 } })
    progressListener.handler!({ payload: { transferred: 0, total: 0, stage } })
    return {}
  })
  try {
    await installFastFlowLm(model, undefined, onProgress)
    expect(seen.mock.calls[0]?.[1]).toMatchObject({
      percent: 0.5,
      size: { transferred: 50, total: 100 },
    })
    expect(seen.mock.calls[1]?.[1]).toMatchObject({ stage })
    expect(seen.mock.calls[1]?.[1]).not.toHaveProperty('percent')
    expect(onProgress.mock.calls).toEqual([[50, 100]])
  } finally {
    seen.mockRestore()
  }
})
