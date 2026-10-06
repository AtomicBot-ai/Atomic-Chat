import { describe, expect, it } from 'vitest'

import { blockerView, deriveSetupView, planSummary } from '../setup-view'
import type {
  EnvironmentOperation,
  RequirementPlan,
  RuntimeInstallation,
} from '@/services/managed-environment/types'

const digest = 'sha256:' + 'a'.repeat(64)

function plan(overrides: Partial<RequirementPlan> = {}): RequirementPlan {
  return {
    plan_digest: digest as RequirementPlan['plan_digest'],
    environment_id: 'default',
    target: { kind: 'runtime', installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' },
    availability: 'setup-required',
    recipe_id: 'linux.install-container-runtime',
    recipe_digest: digest as RequirementPlan['recipe_digest'],
    descriptor_id: 'tensorrt-llm-1.2.1-r1',
    image_digest: digest as RequirementPlan['image_digest'],
    adopts_existing_engine: false,
    system_changes: [],
    download_bytes: 21_000_000_000,
    required_disk_bytes: 67_000_000_000,
    docker_root_dir: null,
    free_disk_bytes: null,
    warnings: [],
    requires_elevation: true,
    may_require_relogin: true,
    may_require_reboot: false,
    blockers: [],
    ...overrides,
  }
}

function operation(overrides: Partial<EnvironmentOperation> = {}): EnvironmentOperation {
  return {
    schema_version: 1,
    operation_id: 'op-1',
    request_id: 'req-1',
    environment_id: 'default',
    target: { kind: 'runtime', installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' },
    kind: 'setup',
    instance_id: 'core-a',
    revision: 1,
    phase: 'checking',
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

const installed: RuntimeInstallation = {
  installation_id: 'tensorrt-llm',
  engine_id: 'tensorrt-llm',
  environment_id: 'default',
  active_descriptor_id: 'tensorrt-llm-1.2.1-r1',
  candidate_descriptor_id: null,
  availability: 'supported',
  status: 'ready',
}

describe('deriveSetupView', () => {
  it('waits for the first probe before saying anything about the machine', () => {
    expect(deriveSetupView({}).kind).toBe('checking')
  })

  it('shows every blocker of a blocked machine and offers no install', () => {
    const view = deriveSetupView({
      plan: plan({
        availability: 'prerequisite-blocked',
        blockers: [
          {
            code: 'MANAGED_PREREQUISITE_BLOCKED',
            message: 'Needs compute capability 8.0 or newer',
            reason: 'compute-capability-too-low',
            params: { required: '8.0', actual: '7.5' },
          },
        ],
      }),
    })

    expect(view.kind).toBe('blocked')
    expect(view.kind === 'blocked' && view.blockers).toHaveLength(1)
  })

  it('offers the install when the machine can be set up and nothing runs', () => {
    expect(deriveSetupView({ plan: plan() }).kind).toBe('not-installed')
  })

  it('follows a running operation before anything else, whatever the plan says now', () => {
    const view = deriveSetupView({
      plan: plan({ availability: 'prerequisite-blocked' }),
      operation: operation({ phase: 'pulling-image' }),
    })

    expect(view).toMatchObject({ kind: 'operation', step: 'working' })
  })

  it('names the step an operation waits on', () => {
    const step = (op: Partial<EnvironmentOperation>) => {
      const view = deriveSetupView({ plan: plan(), operation: operation(op) })
      return view.kind === 'operation' ? view.step : view.kind
    }

    expect(step({ phase: 'awaiting-consent', plan_digest: digest as never })).toBe('consent')
    expect(
      step({
        phase: 'preparing-host',
        pending_host_step: { step_id: 's' } as EnvironmentOperation['pending_host_step'],
      })
    ).toBe('host-step')
    expect(step({ phase: 'preparing-host' })).toBe('working')
    expect(step({ phase: 'relogin-required' })).toBe('relogin')
    expect(step({ phase: 'cancelling' })).toBe('working')
  })

  it('reports an installed engine once no operation runs', () => {
    expect(deriveSetupView({ plan: plan(), installation: installed }).kind).toBe('installed')
  })

  it('keeps a failed setup visible with its error until the engine is installed', () => {
    const failed = operation({
      phase: 'failed',
      error: { code: 'MANAGED_GPU_CHECK_FAILED', message: 'nvidia-smi saw no GPU' },
    })

    expect(deriveSetupView({ plan: plan(), failed })).toMatchObject({
      kind: 'failed',
      operation: { error: { message: 'nvidia-smi saw no GPU' } },
    })
    expect(deriveSetupView({ plan: plan(), failed, installation: installed }).kind).toBe('installed')
  })

  describe('a plan newer than the failed setup (a descriptor published after it failed)', () => {
    const approved = ('sha256:' + 'b'.repeat(64)) as EnvironmentOperation['approved_plan_digest']
    const failedOnOld = operation({
      phase: 'failed',
      approved_plan_digest: approved,
      error: { code: 'MANAGED_PREREQUISITE_BLOCKED', message: 'older than the 615.65.02 TensorRT-LLM needs' },
    })

    it('offers the current plan next to the failure when it could start and is another plan', () => {
      const current = plan({ descriptor_id: 'tensorrt-llm-1.3.0rc29-r3' })
      expect(deriveSetupView({ plan: current, failed: failedOnOld })).toEqual({
        kind: 'failed',
        operation: failedOnOld,
        newerPlan: current,
      })
    })

    it('offers nothing new when the current plan is the one the failed setup was approved for', () => {
      const view = deriveSetupView({ plan: plan({ plan_digest: approved as RequirementPlan['plan_digest'] }), failed: failedOnOld })
      expect(view).toEqual({ kind: 'failed', operation: failedOnOld })
    })

    it('offers nothing when the machine is blocked now', () => {
      for (const availability of ['prerequisite-blocked', 'unsupported'] as const) {
        expect(deriveSetupView({ plan: plan({ availability }), failed: failedOnOld })).toEqual({
          kind: 'failed',
          operation: failedOnOld,
        })
      }
    })

    it('offers nothing for a setup that failed before any consent, or before the first probe answered', () => {
      const unapproved = operation({ phase: 'failed', approved_plan_digest: null })
      expect(deriveSetupView({ plan: plan(), failed: unapproved })).toEqual({ kind: 'failed', operation: unapproved })
      expect(deriveSetupView({ failed: failedOnOld })).toEqual({ kind: 'failed', operation: failedOnOld })
    })
  })
})

describe('blockerView', () => {
  it('explains a card older than Ampere with its compute capability', () => {
    // spec tensorrt-llm-desktop, "Карта старше Ampere".
    expect(
      blockerView({
        code: 'MANAGED_PREREQUISITE_BLOCKED',
        message: 'Needs compute capability 8.0 or newer (Ampere+); the best card here has 7.5.',
        reason: 'compute-capability-too-low',
        params: { required: '8.0', actual: '7.5' },
      })
    ).toMatchObject({ ampere: { required: '8.0', actual: '7.5' } })
  })

  it('carries the exact commands of a manual fix', () => {
    expect(
      blockerView({
        code: 'MANAGED_PREREQUISITE_BLOCKED',
        message: 'Install Docker and the toolkit from the official repositories.',
        reason: 'arch-manual-install',
        commands: ['sudo pacman -S docker nvidia-container-toolkit'],
      })
    ).toMatchObject({ commands: ['sudo pacman -S docker nvidia-container-toolkit'], ampere: null })
  })
})

describe('planSummary', () => {
  it('flags the changes that deserve a second look', () => {
    const summary = planSummary(
      plan({
        system_changes: [
          { code: 'install-packages', text: 'Install the missing packages: docker-ce.' },
          {
            code: 'add-user-to-docker-group',
            text: 'Add ann to the docker group. This grants access equivalent to root on this machine.',
          },
          {
            code: 'restart-docker',
            text: 'Restart Docker to load the new runtime configuration; 3 running container(s) will stop.',
            params: { running_containers: '3' },
          },
        ],
      })
    )

    expect(summary.changes.map((c) => c.warning)).toEqual([false, true, true])
    expect(summary.relogin).toBe(true)
    expect(summary.canStart).toBe(true)
  })

  it('shows where the image goes, what it needs and what is free, and refuses to start without room', () => {
    // spec tensorrt-llm-desktop, "Нет места под образ".
    const summary = planSummary(
      plan({
        availability: 'prerequisite-blocked',
        blockers: [
          {
            code: 'MANAGED_PREREQUISITE_BLOCKED',
            message: 'There is not enough free disk space for the runtime image.',
            reason: 'insufficient-disk',
            params: { free: '20000000000', required: '67000000000' },
          },
        ],
        docker_root_dir: '/var/lib/docker',
        free_disk_bytes: 20_000_000_000,
      })
    )

    expect(summary.disk).toEqual({
      location: 'docker',
      path: '/var/lib/docker',
      requiredBytes: 67_000_000_000,
      freeBytes: 20_000_000_000,
      insufficient: true,
    })
    expect(summary.canStart).toBe(false)
  })

  it('takes the free space from the disk blocker when the plan does not carry it', () => {
    // A plan with nothing measured still says what the blocker knows.
    const summary = planSummary(
      plan({
        blockers: [
          {
            code: 'MANAGED_PREREQUISITE_BLOCKED',
            message: 'There is not enough free disk space for the runtime image.',
            reason: 'insufficient-disk',
            params: { free: '20000000000', required: '67000000000' },
          },
        ],
      })
    )

    expect(summary.disk).toEqual({
      location: 'docker',
      path: null,
      requiredBytes: 67_000_000_000,
      freeBytes: 20_000_000_000,
      insufficient: true,
    })
  })

  it('lists the NVIDIA notices of the descriptor the plan installs, when the core reports them', () => {
    // They come from the descriptor route (core task 2.22), not from the plan.
    expect(planSummary(plan(), ['NGC terms apply.']).notices).toEqual(['NGC terms apply.'])
    expect(planSummary(plan()).notices).toEqual([])
  })

  it('carries every plan warning with the core\'s text and never withholds consent for one', () => {
    // Task 3.17, core 2.23 (F-4).
    const summary = planSummary(
      plan({
        availability: 'setup-required',
        warnings: [
          {
            code: 'docker-address-pools-overlap-routes',
            text: 'Routes 10.0.0.0/8 via tun0 cover the Docker address pools.',
            params: { routes: '10.0.0.0/8', devices: 'tun0' },
          },
          { code: 'something-new', text: 'A warning this app has no words of its own for.' },
        ],
      })
    )
    expect(summary.warnings).toEqual([
      {
        text: 'Routes 10.0.0.0/8 via tun0 cover the Docker address pools.',
        addressPools: { routes: '10.0.0.0/8' },
      },
      { text: 'A warning this app has no words of its own for.', addressPools: null },
    ])
    expect(summary.canStart).toBe(true)
  })

  it('reads a plan from a core that predates warnings as one without any', () => {
    const { warnings: _omitted, ...older } = plan()
    expect(planSummary(older as RequirementPlan).warnings).toEqual([])
  })
})

describe('Windows (change add-tensorrt-llm-windows)', () => {
  const windowsPlan = () =>
    plan({
      system_changes: [
        { code: 'enable-wsl', text: 'Turn on the Windows Subsystem for Linux (wsl --install --no-distribution).' },
        {
          code: 'import-distribution',
          text: 'Download ubuntu 24.04 and import it as "AtomicChat" in C:\\Users\\ann\\AppData\\Local\\AtomicChat\\wsl\\AtomicChat.',
          params: { name: 'AtomicChat', path: 'C:\\Users\\ann\\AppData\\Local\\AtomicChat\\wsl\\AtomicChat' },
        },
        { code: 'provision-distribution', text: 'Inside it, install Docker Engine and the NVIDIA Container Toolkit.' },
      ],
      docker_root_dir: 'C:\\Users\\ann\\AppData\\Local\\AtomicChat\\wsl\\AtomicChat',
      free_disk_bytes: 200_000_000_000,
      may_require_relogin: false,
      may_require_reboot: true,
    })

  it('waits for a restart in reboot-required', () => {
    const view = deriveSetupView({ operation: operation({ phase: 'reboot-required' }) })
    expect(view).toMatchObject({ kind: 'operation', step: 'reboot' })
  })

  it('says a restart may follow, and that the space is the distribution’s, on the volume that holds it', () => {
    const summary = planSummary(windowsPlan(), [], 'wsl-docker')
    expect(summary.reboot).toBe(true)
    expect(summary.relogin).toBe(false)
    expect(summary.disk).toMatchObject({
      location: 'distribution',
      path: 'C:\\Users\\ann\\AppData\\Local\\AtomicChat\\wsl\\AtomicChat',
      freeBytes: 200_000_000_000,
      insufficient: false,
    })
    expect(summary.canStart).toBe(true)
  })

  it('lists enabling WSL, the import with its path and Docker inside it, and flags the step that needs a restart', () => {
    const { changes } = planSummary(windowsPlan(), [], 'wsl-docker')
    expect(changes.map((change) => change.warning)).toEqual([true, false, false])
    expect(changes[1].text).toContain('AtomicChat\\wsl\\AtomicChat')
  })

  it('keeps Docker’s storage as the disk on Linux', () => {
    expect(planSummary(plan({ docker_root_dir: '/var/lib/docker' })).disk.location).toBe('docker')
    expect(planSummary(plan(), [], 'linux-docker').reboot).toBe(false)
  })
})
