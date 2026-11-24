import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import {
  deviceContextLimit,
  fetchContextPlan,
  readContextPlan,
  resetContextPlanCache,
} from '@/lib/context-plan'

const plan = {
  recommendedCtx: 65536,
  maxCtx: 65536,
  trainedCtx: 131072,
  kvBytesPerToken: 131072,
  basis: 'gpu',
}

describe('readContextPlan', () => {
  it('reads the plan of a capabilities answer', () => {
    expect(readContextPlan({ maxCtxTrain: 131072, contextPlan: plan })).toEqual(
      plan
    )
    expect(
      readContextPlan({
        contextPlan: { recommendedCtx: 32768, maxCtx: 32768, basis: 'unified' },
      })
    ).toEqual({ recommendedCtx: 32768, maxCtx: 32768, basis: 'unified' })
  })

  it('has none from an older core or a plan that does not hold up', () => {
    expect(readContextPlan({ maxCtxTrain: 131072 })).toBeUndefined()
    expect(readContextPlan(null)).toBeUndefined()
    expect(
      readContextPlan({ contextPlan: { ...plan, maxCtx: 0 } })
    ).toBeUndefined()
    expect(
      readContextPlan({ contextPlan: { ...plan, basis: 'guess' } })
    ).toBeUndefined()
  })
})

describe('fetchContextPlan', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    resetContextPlanCache()
  })

  it('asks the capabilities route once per model while the answer is fresh', async () => {
    invokeMock.mockResolvedValue({ contextPlan: plan })
    const [first, second] = await Promise.all([
      fetchContextPlan('llamacpp-upstream', 'org/model-Q4'),
      fetchContextPlan('llamacpp-upstream', 'org/model-Q4'),
    ])
    expect(first).toEqual(plan)
    expect(second).toEqual(plan)
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('atomic_core_call', {
      method: 'GET',
      path: '/models/llamacpp-upstream/org/model-Q4/capabilities',
      body: null,
    })
  })

  it('answers nothing for a cloud provider, an older core or a failure', async () => {
    expect(await fetchContextPlan('openai', 'gpt')).toBeUndefined()
    expect(invokeMock).not.toHaveBeenCalled()

    invokeMock.mockResolvedValueOnce({ maxCtxTrain: 4096 })
    expect(await fetchContextPlan('mlx', 'm')).toBeUndefined()

    invokeMock.mockRejectedValueOnce({ code: 'NOT_FOUND', message: 'gone' })
    expect(await fetchContextPlan('llamacpp', 'm')).toBeUndefined()
  })
})

describe('deviceContextLimit', () => {
  it('names the training maximum only when the device holds less', () => {
    expect(deviceContextLimit(undefined, 131072)).toBeUndefined()
    expect(deviceContextLimit(plan as never)).toEqual({
      maxCtx: 65536,
      trainedCtx: 131072,
    })
    const unbounded = { recommendedCtx: 40960, maxCtx: 40960, basis: 'cpu' }
    expect(deviceContextLimit(unbounded as never, 40960)).toEqual({
      maxCtx: 40960,
    })
    // The engine's training maximum stands in when the plan has none.
    expect(deviceContextLimit(unbounded as never, 262144)).toEqual({
      maxCtx: 40960,
      trainedCtx: 262144,
    })
    expect(deviceContextLimit(unbounded as never)).toEqual({ maxCtx: 40960 })
  })
})
