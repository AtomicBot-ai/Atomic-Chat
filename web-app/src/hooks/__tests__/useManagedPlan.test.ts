import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({ probe: vi.fn() }))
vi.mock('@/services/managed-environment/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/managed-environment/client')>()),
  ...client,
}))

import { resetManagedPlansForTests, useManagedPlan } from '../useManagedPlan'
import { useManagedEnvironmentStore } from '@/stores/managed-environment-store'
import type { EnvironmentSnapshot, RequirementPlan } from '@/services/managed-environment/types'

const digest = (char: string) => `sha256:${char.repeat(64)}` as RequirementPlan['plan_digest']

function plan(overrides: Partial<RequirementPlan> = {}): RequirementPlan {
  return {
    plan_digest: digest('a'),
    environment_id: 'default',
    target: { kind: 'runtime', installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' },
    availability: 'setup-required',
    recipe_id: 'linux.install-container-runtime',
    recipe_digest: digest('a'),
    descriptor_id: 'tensorrt-llm-1.3.0rc29-r2',
    image_digest: null,
    adopts_existing_engine: false,
    system_changes: [],
    download_bytes: null,
    required_disk_bytes: null,
    requires_elevation: false,
    may_require_relogin: false,
    may_require_reboot: false,
    blockers: [],
    docker_root_dir: null,
    free_disk_bytes: null,
    warnings: [],
    ...overrides,
  }
}

function environment(overrides: Partial<EnvironmentSnapshot> = {}): EnvironmentSnapshot {
  return {
    schema_version: 1,
    environment_id: 'default',
    instance_id: 'core-a',
    revision: 1,
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

const store = () => useManagedEnvironmentStore.getState()

const target = (engine: string) => ({ kind: 'runtime', installation_id: engine, engine_id: engine })

beforeEach(() => {
  vi.clearAllMocks()
  resetManagedPlansForTests()
  store().reset()
  store().applySnapshot({ instance_id: 'core-a', environments: [environment()] })
})

describe('useManagedPlan', () => {
  it('asks the core once per snapshot revision, however many screens read the plan', async () => {
    client.probe.mockResolvedValue(plan())

    const first = renderHook(() => useManagedPlan('tensorrt-llm'))
    const second = renderHook(() => useManagedPlan('tensorrt-llm'))

    await waitFor(() => expect(first.result.current.plan?.plan_digest).toBe(digest('a')))
    expect(second.result.current.plan?.plan_digest).toBe(digest('a'))
    // A screen opened later reads the same answer.
    const later = renderHook(() => useManagedPlan('tensorrt-llm'))
    expect(later.result.current.plan?.plan_digest).toBe(digest('a'))
    expect(client.probe).toHaveBeenCalledTimes(1)
    expect(client.probe).toHaveBeenCalledWith('tensorrt-llm', target('tensorrt-llm'))
  })

  it('does not ask again because its own probe made the core publish a new revision', async () => {
    // The core publishes the environment after every look at the host (`onAssessment`): a probe
    // bumps the snapshot's revision without changing what the plan depends on.
    let revision = 1
    client.probe.mockImplementation(async () => {
      revision += 1
      store().applyEnvironment(environment({ revision, availability: 'setup-required' }))
      return plan()
    })

    const { result } = renderHook(() => useManagedPlan('tensorrt-llm'))

    await waitFor(() => expect(result.current.plan?.plan_digest).toBe(digest('a')))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current.probing).toBe(false)
    expect(client.probe).toHaveBeenCalledTimes(1)
  })

  it('asks again when the snapshot changes, with the installed descriptor as the hint', async () => {
    client.probe.mockResolvedValue(plan())
    const { result } = renderHook(() => useManagedPlan('tensorrt-llm'))
    await waitFor(() => expect(result.current.plan).toBeDefined())

    client.probe.mockResolvedValue(plan({ plan_digest: digest('b') }))
    act(() => {
      store().applyEnvironment(
        environment({
          revision: 2,
          installations: [
            {
              installation_id: 'tensorrt-llm',
              engine_id: 'tensorrt-llm',
              environment_id: 'default',
              active_descriptor_id: 'tensorrt-llm-1.2.1-r1',
              candidate_descriptor_id: null,
              availability: 'supported',
              status: 'ready',
            },
          ],
        })
      )
    })

    await waitFor(() => expect(result.current.plan?.plan_digest).toBe(digest('b')))
    expect(client.probe).toHaveBeenCalledTimes(2)
    expect(client.probe).toHaveBeenLastCalledWith('tensorrt-llm-1.2.1-r1', target('tensorrt-llm'))
  })

  it('checks again on request even within one revision, and every reader sees the new plan', async () => {
    client.probe.mockResolvedValue(plan())
    const panel = renderHook(() => useManagedPlan('tensorrt-llm'))
    const hub = renderHook(() => useManagedPlan('tensorrt-llm'))
    await waitFor(() => expect(panel.result.current.plan).toBeDefined())

    client.probe.mockResolvedValue(plan({ plan_digest: digest('c') }))
    let next: RequirementPlan | undefined
    await act(async () => {
      next = await panel.result.current.recheck()
    })

    expect(next?.plan_digest).toBe(digest('c'))
    expect(hub.result.current.plan?.plan_digest).toBe(digest('c'))
  })

  it('asks again on the next screen after a probe failed, instead of keeping the failure for the revision', async () => {
    client.probe.mockRejectedValueOnce(new Error('core is restarting'))
    const first = renderHook(() => useManagedPlan('tensorrt-llm'))
    await waitFor(() => expect(first.result.current.error).toBe('core is restarting'))
    first.unmount()

    client.probe.mockResolvedValue(plan())
    const again = renderHook(() => useManagedPlan('tensorrt-llm'))

    await waitFor(() => expect(again.result.current.plan?.plan_digest).toBe(digest('a')))
    expect(again.result.current.error).toBeNull()
    expect(client.probe).toHaveBeenCalledTimes(2)
  })

  it('keeps the reason a probe failed and asks nothing while disabled', async () => {
    client.probe.mockRejectedValue(new Error('core is not running'))
    const off = renderHook(() => useManagedPlan('tensorrt-llm', { enabled: false }))
    expect(off.result.current.plan).toBeUndefined()
    expect(client.probe).not.toHaveBeenCalled()

    const { result } = renderHook(() => useManagedPlan('tensorrt-llm'))
    await waitFor(() => expect(result.current.error).toBe('core is not running'))
    expect(result.current.plan).toBeUndefined()
    expect(result.current.probing).toBe(false)
  })

  it('keeps one plan per engine: each is probed with its own target and neither answers for the other', async () => {
    client.probe.mockImplementation(async (descriptor: string) =>
      descriptor === 'second-engine'
        ? plan({
            plan_digest: digest('e'),
            target: target('second-engine') as RequirementPlan['target'],
            descriptor_id: 'second-engine-1-r1',
          })
        : plan({
            availability: 'prerequisite-blocked',
            blockers: [{ code: 'MANAGED_PREREQUISITE_BLOCKED', message: 'driver', reason: 'driver-too-old' }],
          })
    )

    const trt = renderHook(() => useManagedPlan('tensorrt-llm'))
    const second = renderHook(() => useManagedPlan('second-engine'))

    await waitFor(() => expect(second.result.current.plan?.plan_digest).toBe(digest('e')))
    await waitFor(() => expect(trt.result.current.plan?.availability).toBe('prerequisite-blocked'))
    expect(second.result.current.plan?.blockers).toEqual([])
    expect(client.probe).toHaveBeenCalledWith('tensorrt-llm', target('tensorrt-llm'))
    expect(client.probe).toHaveBeenCalledWith('second-engine', target('second-engine'))
    expect(client.probe).toHaveBeenCalledTimes(2)

    // Rechecking one engine asks nothing about the other.
    await act(async () => {
      await second.result.current.recheck()
    })
    expect(client.probe).toHaveBeenCalledTimes(3)
    expect(client.probe).toHaveBeenLastCalledWith('second-engine', target('second-engine'))
    expect(trt.result.current.plan?.availability).toBe('prerequisite-blocked')
  })
})
