import { beforeEach, describe, expect, it } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import {
  probeFastFlowLm,
  fastFlowLmOperations,
  fastFlowLmOperation,
  beginFastFlowLmPreparation,
  consentFastFlowLmPreparation,
  resumeFastFlowLmPreparation,
  cancelFastFlowLmPreparation,
  checkFastFlowLmModel,
  fastFlowLmMaintenance,
  beginFastFlowLmMaintenance,
  completeFastFlowLmMaintenance,
} from './core'

describe('FastFlowLM control adapter', () => {
  const calls: unknown[] = []
  beforeEach(() => {
    calls.length = 0
    mockIPC((command, args) => {
      expect(command).toBe('atomic_core_call')
      calls.push(args)
      return { state: 'ready' }
    })
  })

  it('rechecks readiness read-only and recovers the original preparation operation', async () => {
    await expect(probeFastFlowLm()).resolves.toEqual({ state: 'ready' })
    await fastFlowLmOperations()
    await fastFlowLmOperation('op/one')
    await beginFastFlowLmPreparation('request-1')
    await consentFastFlowLmPreparation('op-1', {
      approved_plan_digest: 'sha256:abc',
      expected_revision: 4,
    })
    await resumeFastFlowLmPreparation('op-1', 5)
    await cancelFastFlowLmPreparation('op-1')
    expect(calls).toEqual([
      { method: 'POST', path: '/runtimes/fastflowlm/probe', body: {} },
      { method: 'GET', path: '/runtimes/fastflowlm/operations', body: null },
      {
        method: 'GET',
        path: '/runtimes/fastflowlm/operations/op%2Fone',
        body: null,
      },
      {
        method: 'POST',
        path: '/runtimes/fastflowlm/operations',
        body: { request_id: 'request-1' },
      },
      {
        method: 'POST',
        path: '/runtimes/fastflowlm/operations/op-1/consent',
        body: { approved_plan_digest: 'sha256:abc', expected_revision: 4 },
      },
      {
        method: 'POST',
        path: '/runtimes/fastflowlm/operations/op-1/resume',
        body: { expected_revision: 5 },
      },
      {
        method: 'POST',
        path: '/runtimes/fastflowlm/operations/op-1/cancel',
        body: {},
      },
    ])
  })

  it('checks local files and retains maintenance identity across a lost response', async () => {
    await checkFastFlowLmModel({ path: '/data/fastflowlm/models/staging' })
    const request = {
      request_id: 'install-1',
      model_id: 'qwen3-06b',
      kind: 'replace' as const,
    }
    await beginFastFlowLmMaintenance(request)
    await beginFastFlowLmMaintenance(request)
    await fastFlowLmMaintenance('maintenance/1')
    await completeFastFlowLmMaintenance('maintenance/1')
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/models/fastflowlm/check',
        body: { path: '/data/fastflowlm/models/staging' },
      },
      { method: 'POST', path: '/models/fastflowlm/maintenance', body: request },
      { method: 'POST', path: '/models/fastflowlm/maintenance', body: request },
      {
        method: 'GET',
        path: '/models/fastflowlm/maintenance/maintenance%2F1',
        body: null,
      },
      {
        method: 'POST',
        path: '/models/fastflowlm/maintenance/maintenance%2F1/complete',
        body: {},
      },
    ])
  })
})
