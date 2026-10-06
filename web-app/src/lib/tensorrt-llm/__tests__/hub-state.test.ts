import { describe, expect, it } from 'vitest'

import { tensorrtHubState } from '../hub-state'
import type {
  EnvironmentSnapshot,
  ManagedBlocker,
  RequirementPlan,
  RuntimeInstallation,
} from '@/services/managed-environment/types'

const digest = `sha256:${'a'.repeat(64)}` as RequirementPlan['plan_digest']

function plan(overrides: Partial<RequirementPlan> = {}): RequirementPlan {
  return {
    plan_digest: digest,
    environment_id: 'default',
    target: { kind: 'runtime', installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' },
    availability: 'setup-required',
    recipe_id: 'linux.install-container-runtime',
    recipe_digest: digest,
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

const environment: EnvironmentSnapshot = {
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
}

const ready: RuntimeInstallation = {
  installation_id: 'tensorrt-llm',
  engine_id: 'tensorrt-llm',
  environment_id: 'default',
  active_descriptor_id: 'tensorrt-llm-1.2.1-r1',
  candidate_descriptor_id: null,
  availability: 'supported',
  status: 'ready',
}

const blocker = (reason: string, params: Record<string, string> = {}): ManagedBlocker => ({
  code: 'prerequisite-blocked',
  reason,
  message: `${reason} message`,
  params,
})

describe('tensorrtHubState', () => {
  it.each([
    {
      name: 'macOS: no provider, no snapshot',
      input: { providerShown: false, environment: undefined, installation: undefined, plan: undefined },
      expected: { visible: false, state: 'unknown', descriptorId: null },
    },
    {
      name: 'no snapshot yet: nothing is claimed',
      input: { providerShown: true, environment: undefined, installation: undefined, plan: undefined },
      expected: { visible: true, state: 'unknown', descriptorId: null },
    },
    {
      name: 'snapshot without a plan yet',
      input: { providerShown: true, environment, installation: undefined, plan: undefined },
      expected: { visible: true, state: 'unknown', descriptorId: null },
    },
    {
      name: 'one card older than Ampere: the format is not offered',
      input: {
        providerShown: true,
        environment,
        installation: undefined,
        plan: plan({
          availability: 'prerequisite-blocked',
          blockers: [blocker('compute-capability-too-low', { required: '8.0', actual: '7.5' })],
        }),
      },
      expected: { visible: false, state: 'blocked', descriptorId: 'tensorrt-llm-1.3.0rc29-r2' },
    },
    {
      name: 'driver too old: offered, blocked with the reason',
      input: {
        providerShown: true,
        environment,
        installation: undefined,
        plan: plan({
          availability: 'prerequisite-blocked',
          blockers: [blocker('driver-too-old', { required: '615.65.02', actual: '580.95.05' })],
        }),
      },
      expected: { visible: true, state: 'blocked', descriptorId: 'tensorrt-llm-1.3.0rc29-r2' },
    },
    {
      name: 'not installed, nothing in the way: the plan names the descriptor',
      input: { providerShown: true, environment, installation: undefined, plan: plan() },
      expected: { visible: true, state: 'not-installed', descriptorId: 'tensorrt-llm-1.3.0rc29-r2' },
    },
    {
      name: 'installed: the installation pins the descriptor, even before the plan',
      input: { providerShown: true, environment, installation: ready, plan: undefined },
      expected: { visible: true, state: 'ready', descriptorId: 'tensorrt-llm-1.2.1-r1' },
    },
    {
      name: 'installed: a blocker of a re-install does not take the engine away',
      input: {
        providerShown: true,
        environment,
        installation: ready,
        plan: plan({ blockers: [blocker('insufficient-disk')] }),
      },
      expected: { visible: true, state: 'ready', descriptorId: 'tensorrt-llm-1.2.1-r1' },
    },
  ])('$name', ({ input, expected }) => {
    expect(tensorrtHubState(input)).toMatchObject(expected)
  })

  it('hands the blockers over with their reasons for the panel', () => {
    const state = tensorrtHubState({
      providerShown: true,
      environment,
      installation: undefined,
      plan: plan({
        availability: 'prerequisite-blocked',
        blockers: [blocker('driver-too-old', { required: '615.65.02', actual: '580.95.05' })],
      }),
    })
    expect(state.blockers.map((b) => b.reason)).toEqual(['driver-too-old'])
    expect(state.blockers[0].params).toEqual({ required: '615.65.02', actual: '580.95.05' })
  })

  it('an installation still being set up is not ready', () => {
    const state = tensorrtHubState({
      providerShown: true,
      environment,
      installation: { ...ready, status: 'installing', active_descriptor_id: null },
      plan: plan(),
    })
    expect(state.state).toBe('not-installed')
    expect(state.descriptorId).toBe('tensorrt-llm-1.3.0rc29-r2')
  })
})
