import { beforeEach, describe, expect, it } from 'vitest'

import {
  selectFailedSetup,
  selectSetupOperation,
  selectTensorrtInstallation,
  useManagedEnvironmentStore,
} from '../managed-environment-store'
import type {
  EnvironmentOperation,
  EnvironmentSnapshot,
} from '@/services/managed-environment/types'

function environment(
  instance: string,
  revision: number,
  overrides: Partial<EnvironmentSnapshot> = {}
): EnvironmentSnapshot {
  return {
    schema_version: 1,
    environment_id: 'default',
    instance_id: instance,
    revision,
    executor: 'linux-docker',
    availability: 'setup-required',
    gpus: [],
    blockers: [],
    selinux: false,
    installations: [],
    active_operation_id: null,
    minimum_app_version: null,
    ...overrides,
  }
}

function operation(
  instance: string,
  revision: number,
  overrides: Partial<EnvironmentOperation> = {}
): EnvironmentOperation {
  return {
    schema_version: 1,
    operation_id: 'op-1',
    request_id: 'req-1',
    environment_id: 'default',
    target: { kind: 'runtime', installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' },
    kind: 'setup',
    instance_id: instance,
    revision,
    phase: 'pulling-image',
    plan_digest: null,
    approved_plan_digest: null,
    carried_plan_digest: null,
    progress: null,
    pending_host_step: null,
    completed_step_ids: [],
    cancellation_requested: false,
    error: null,
    ...overrides,
  }
}

const snapshot = (
  instance: string,
  environments: EnvironmentSnapshot[],
  operations: EnvironmentOperation[] = []
) => ({ instance_id: instance, environments, environment_operations: operations })

const store = () => useManagedEnvironmentStore.getState()

beforeEach(() => store().reset())

describe('managed environment store', () => {
  it('rebuilds from the snapshot, then follows only strictly newer events of the same core', () => {
    store().applySnapshot(
      snapshot('core-a', [environment('core-a', 3)], [operation('core-a', 10)])
    )

    // A byte-progress tick, a phase change: newer revisions of the current core are applied.
    store().applyOperation(
      operation('core-a', 11, {
        progress: { label: 'pull', completed: 5, total: 10, unit: 'bytes' },
      })
    )
    store().applyEnvironment(environment('core-a', 4, { availability: 'supported' }))
    expect(store().operations['op-1'].progress?.completed).toBe(5)
    expect(store().environments['default'].availability).toBe('supported')

    // An equal revision is a no-op, an older one would rewind the bar.
    store().applyOperation(operation('core-a', 11, { phase: 'failed' }))
    store().applyOperation(operation('core-a', 9, { phase: 'checking' }))
    store().applyEnvironment(environment('core-a', 2, { availability: 'unsupported' }))
    expect(store().operations['op-1'].phase).toBe('pulling-image')
    expect(store().environments['default'].availability).toBe('supported')

    // An event from a core the app is not attached to says nothing about this one.
    store().applyOperation(operation('core-z', 99, { phase: 'ready' }))
    expect(store().operations['op-1'].phase).toBe('pulling-image')
  })

  it('stops trusting events once detached, and a reconnect to the same core resumes from its snapshot', () => {
    store().applySnapshot(snapshot('core-a', [environment('core-a', 3)], [operation('core-a', 10)]))

    store().detach()
    expect(store().attached).toBe(false)
    store().applyOperation(operation('core-a', 12, { phase: 'verifying' }))
    expect(store().operations['op-1'].phase).toBe('pulling-image')

    // The relay re-reads the snapshot on reattach; what it missed is in there.
    store().applySnapshot(
      snapshot('core-a', [environment('core-a', 5)], [operation('core-a', 13, { phase: 'verifying' })])
    )
    expect(store().attached).toBe(true)
    expect(store().operations['op-1'].phase).toBe('verifying')
  })

  it('takes a new core wholesale, even where its revisions are lower', () => {
    // After a relogin the app and its core start again: the operation that waited in
    // `relogin-required` is continued by the new core, and every revision counter restarts.
    store().applySnapshot(
      snapshot(
        'core-a',
        [environment('core-a', 40, { active_operation_id: 'op-1' })],
        [operation('core-a', 30, { phase: 'relogin-required' })]
      )
    )

    store().applySnapshot(
      snapshot(
        'core-b',
        [environment('core-b', 1, { active_operation_id: 'op-1' })],
        [operation('core-b', 2, { phase: 'preparing-environment' })]
      )
    )
    store().applyOperation(operation('core-b', 3, { phase: 'pulling-image' }))

    expect(store().instanceId).toBe('core-b')
    expect(store().environments['default'].revision).toBe(1)
    expect(store().operations['op-1'].phase).toBe('pulling-image')
    // And the old core's late events no longer apply.
    store().applyOperation(operation('core-a', 31, { phase: 'failed' }))
    expect(store().operations['op-1'].phase).toBe('pulling-image')
  })

  it('answers the TensorRT-LLM installation and its running setup', () => {
    store().applySnapshot(
      snapshot(
        'core-a',
        [
          environment('core-a', 1, {
            active_operation_id: 'op-1',
            installations: [
              {
                installation_id: 'tensorrt-llm',
                engine_id: 'tensorrt-llm',
                environment_id: 'default',
                active_descriptor_id: null,
                candidate_descriptor_id: null,
                availability: 'setup-required',
                status: 'installing',
              },
            ],
          }),
        ],
        [operation('core-a', 1)]
      )
    )

    expect(selectTensorrtInstallation(store())?.status).toBe('installing')
    expect(selectSetupOperation(store())?.operation_id).toBe('op-1')
  })

  it('names no running operation once it is over', () => {
    store().applySnapshot(
      snapshot('core-a', [environment('core-a', 1)], [operation('core-a', 5, { phase: 'ready' })])
    )

    expect(selectSetupOperation(store())).toBeUndefined()
  })

  it('keeps the last failed TensorRT-LLM setup, and only a setup', () => {
    store().applySnapshot(
      snapshot(
        'core-a',
        [environment('core-a', 1)],
        [
          operation('core-a', 3, {
            phase: 'failed',
            error: { code: 'MANAGED_GPU_CHECK_FAILED', message: 'no GPU in the container' },
          }),
          operation('core-a', 4, { operation_id: 'op-rm', kind: 'remove', phase: 'failed' }),
        ]
      )
    )

    expect(selectFailedSetup(store())?.error?.message).toBe('no GPU in the container')
  })
})
