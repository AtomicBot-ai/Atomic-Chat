import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({ probe: vi.fn() }))
vi.mock('@/services/managed-environment/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/managed-environment/client')>()),
  ...client,
}))

import { resetTensorrtPlanForTests, useTensorrtPlan } from '../useTensorrtPlan'
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

beforeEach(() => {
  vi.clearAllMocks()
  resetTensorrtPlanForTests()
  store().reset()
  store().applySnapshot({ instance_id: 'core-a', environments: [environment()] })
})

describe('useTensorrtPlan', () => {
  it('asks the core once per snapshot revision, however many screens read the plan', async () => {
    client.probe.mockResolvedValue(plan())

    const first = renderHook(() => useTensorrtPlan())
    const second = renderHook(() => useTensorrtPlan())

    await waitFor(() => expect(first.result.current.plan?.plan_digest).toBe(digest('a')))
    expect(second.result.current.plan?.plan_digest).toBe(digest('a'))
    // A screen opened later reads the same answer.
    const later = renderHook(() => useTensorrtPlan())
    expect(later.result.current.plan?.plan_digest).toBe(digest('a'))
    expect(client.probe).toHaveBeenCalledTimes(1)
    expect(client.probe).toHaveBeenCalledWith('tensorrt-llm')
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

    const { result } = renderHook(() => useTensorrtPlan())

    await waitFor(() => expect(result.current.plan?.plan_digest).toBe(digest('a')))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current.probing).toBe(false)
    expect(client.probe).toHaveBeenCalledTimes(1)
  })

  it('asks again when the snapshot changes, with the installed descriptor as the hint', async () => {
    client.probe.mockResolvedValue(plan())
    const { result } = renderHook(() => useTensorrtPlan())
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
    expect(client.probe).toHaveBeenLastCalledWith('tensorrt-llm-1.2.1-r1')
  })

  it('checks again on request even within one revision, and every reader sees the new plan', async () => {
    client.probe.mockResolvedValue(plan())
    const panel = renderHook(() => useTensorrtPlan())
    const hub = renderHook(() => useTensorrtPlan())
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
    const first = renderHook(() => useTensorrtPlan())
    await waitFor(() => expect(first.result.current.error).toBe('core is restarting'))
    first.unmount()

    client.probe.mockResolvedValue(plan())
    const again = renderHook(() => useTensorrtPlan())

    await waitFor(() => expect(again.result.current.plan?.plan_digest).toBe(digest('a')))
    expect(again.result.current.error).toBeNull()
    expect(client.probe).toHaveBeenCalledTimes(2)
  })

  it('keeps the reason a probe failed and asks nothing while disabled', async () => {
    client.probe.mockRejectedValue(new Error('core is not running'))
    const off = renderHook(() => useTensorrtPlan({ enabled: false }))
    expect(off.result.current.plan).toBeUndefined()
    expect(client.probe).not.toHaveBeenCalled()

    const { result } = renderHook(() => useTensorrtPlan())
    await waitFor(() => expect(result.current.error).toBe('core is not running'))
    expect(result.current.plan).toBeUndefined()
    expect(result.current.probing).toBe(false)
  })
})
