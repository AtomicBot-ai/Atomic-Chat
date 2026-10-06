import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Keys and their parameters are what the panel decides; the English copy lives in the locale file.
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))

const client = vi.hoisted(() => ({
  probe: vi.fn(),
  beginOperation: vi.fn(),
  resumeOperation: vi.fn(),
  cancelOperation: vi.fn(),
  runHostStep: vi.fn(),
}))
const descriptors = vi.hoisted(() => ({ describeDescriptor: vi.fn() }))
vi.mock('@/services/tensorrt-llm/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/tensorrt-llm/models')>()),
  ...descriptors,
}))
vi.mock('@/services/managed-environment/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/managed-environment/client')>()),
  ...client,
}))

import { resetHostStepPromptsForTests, TensorrtLlmSetupPanel } from '../TensorrtLlmSetupPanel'
import { resetTensorrtPlanForTests } from '@/hooks/useTensorrtPlan'
import { useManagedEnvironmentStore } from '@/stores/managed-environment-store'
import { useModelProvider } from '@/hooks/useModelProvider'
import type {
  EnvironmentOperation,
  EnvironmentSnapshot,
  RequirementPlan,
  RuntimeInstallation,
} from '@/services/managed-environment/types'

const digest = ('sha256:' + 'a'.repeat(64)) as RequirementPlan['plan_digest']

function plan(overrides: Partial<RequirementPlan> = {}): RequirementPlan {
  return {
    plan_digest: digest,
    environment_id: 'default',
    target: { kind: 'runtime', installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' },
    availability: 'setup-required',
    recipe_id: 'linux.install-container-runtime',
    recipe_digest: digest,
    descriptor_id: 'tensorrt-llm-1.2.1-r1',
    image_digest: digest,
    adopts_existing_engine: false,
    system_changes: [
      {
        code: 'add-user-to-docker-group',
        text: 'Add ann to the docker group. This grants access equivalent to root on this machine.',
      },
    ],
    download_bytes: 21 * 1024 ** 3,
    required_disk_bytes: 63 * 1024 ** 3,
    docker_root_dir: '/var/lib/docker',
    free_disk_bytes: 200 * 1024 ** 3,
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

const installedEngine: RuntimeInstallation = {
  installation_id: 'tensorrt-llm',
  engine_id: 'tensorrt-llm',
  environment_id: 'default',
  active_descriptor_id: 'tensorrt-llm-1.2.1-r1',
  candidate_descriptor_id: null,
  availability: 'supported',
  status: 'ready',
}

const store = () => useManagedEnvironmentStore.getState()

function seed(env: EnvironmentSnapshot, operations: EnvironmentOperation[] = []) {
  store().applySnapshot({ instance_id: 'core-a', environments: [env], environment_operations: operations })
}

/** The core's next word on the operation, as the relay delivers it. */
function coreSays(op: EnvironmentOperation) {
  act(() => {
    // The environment keeps its executor and distribution: Linux by default, WSL in the Windows cases.
    const held = Object.values(store().environments)[0]
    store().applyEnvironment(
      environment({
        executor: held?.executor ?? 'linux-docker',
        ...(held?.distribution !== undefined ? { distribution: held.distribution } : {}),
        revision: op.revision + 100,
        active_operation_id: op.operation_id,
      })
    )
    store().applyOperation(op)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetHostStepPromptsForTests()
  resetTensorrtPlanForTests()
  store().reset()
  seed(environment())
  client.probe.mockResolvedValue(plan())
  client.beginOperation.mockResolvedValue(operation())
  client.resumeOperation.mockResolvedValue(operation())
  client.cancelOperation.mockResolvedValue(operation())
  client.runHostStep.mockResolvedValue({ outcome: 'completed' })
  descriptors.describeDescriptor.mockResolvedValue(null)
})

describe('TensorrtLlmSetupPanel', () => {
  it('offers the install once the core has answered, though its probe made it publish a new revision', async () => {
    let revision = 1
    client.probe.mockImplementation(async () => {
      revision += 1
      act(() => store().applyEnvironment(environment({ revision })))
      return plan()
    })

    render(<TensorrtLlmSetupPanel />)

    const install = await screen.findByRole('button', { name: 'providers:tensorrt.install' })
    await waitFor(() => expect(install).toBeEnabled())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(install).toBeEnabled()
    expect(client.probe).toHaveBeenCalledTimes(1)
  })

  it('asks the core again every time the page opens, as something may have changed outside the app', async () => {
    client.probe.mockResolvedValueOnce(
      plan({
        availability: 'prerequisite-blocked',
        blockers: [{ code: 'prerequisite-blocked', reason: 'docker-missing', message: 'Docker is not installed.' }],
      })
    )
    const first = render(<TensorrtLlmSetupPanel />)
    expect(await screen.findByText('Docker is not installed.')).toBeInTheDocument()
    first.unmount()

    // Docker installed in a terminal: the core's snapshot did not change.
    render(<TensorrtLlmSetupPanel />)

    expect(await screen.findByRole('button', { name: 'providers:tensorrt.install' })).toBeInTheDocument()
    expect(screen.queryByText('Docker is not installed.')).not.toBeInTheDocument()
    expect(client.probe).toHaveBeenCalledTimes(2)
  })

  it('shows the whole plan and installs nothing when the person closes it', async () => {
    // spec "Отказ от согласия".
    render(<TensorrtLlmSetupPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'providers:tensorrt.install' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/grants access equivalent to root/)).toBeInTheDocument()
    expect(within(dialog).getByText(/providers:tensorrt.plan.relogin/)).toBeInTheDocument()
    expect(within(dialog).getByText(/providers:tensorrt.plan.download/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'providers:tensorrt.plan.cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(client.beginOperation).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'providers:tensorrt.install' })).toBeInTheDocument()
  })

  it('warns before consent that a VPN may keep Docker from starting, and still lets the person agree', async () => {
    // spec "VPN перекрывает адреса Docker" (task 3.17, core 2.23).
    const text =
      'The routes 10.0.0.0/8 via tun0 cover every Docker address pool: exclude them from the VPN or set default-address-pools in /etc/docker/daemon.json.'
    client.probe.mockResolvedValue(
      plan({
        warnings: [
          {
            code: 'docker-address-pools-overlap-routes',
            text,
            params: { routes: '10.0.0.0/8', devices: 'tun0' },
          },
        ],
      })
    )
    render(<TensorrtLlmSetupPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'providers:tensorrt.install' }))

    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText('providers:tensorrt.plan.warning.addressPools {"routes":"10.0.0.0/8"}')
    ).toBeInTheDocument()
    expect(within(dialog).getByText('providers:tensorrt.plan.warning.addressPoolsFix')).toBeInTheDocument()
    expect(within(dialog).getByText(text)).toBeInTheDocument()

    const agree = within(dialog).getByRole('button', { name: 'providers:tensorrt.plan.agree' })
    expect(agree).toBeEnabled()
    fireEvent.click(agree)
    await waitFor(() => expect(client.beginOperation).toHaveBeenCalledTimes(1))
  })

  it('shows no warning block for a plan without warnings', async () => {
    render(<TensorrtLlmSetupPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'providers:tensorrt.install' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText(/providers:tensorrt.plan.warning/)).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'providers:tensorrt.plan.agree' })).toBeEnabled()
  })

  it('shows the NVIDIA notices of the descriptor the plan installs, and says so when the core has none', async () => {
    descriptors.describeDescriptor.mockResolvedValue({
      descriptor_id: 'tensorrt-llm-1.2.1-r1',
      engine_id: 'tensorrt-llm',
      notices: ['Use of the NGC container is subject to the NVIDIA AI Product Agreement.'],
      curated_models: [],
      supported_architectures: [],
    })
    render(<TensorrtLlmSetupPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'providers:tensorrt.install' }))

    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(/NVIDIA AI Product Agreement/)).toBeInTheDocument()
    expect(descriptors.describeDescriptor).toHaveBeenCalledWith('tensorrt-llm-1.2.1-r1')
    expect(within(dialog).queryByText('providers:tensorrt.plan.noticesMissing')).not.toBeInTheDocument()
  })

  it('on consent starts the setup, approves exactly the plan it showed, asks for the system password and then explains the sign-in', async () => {
    // spec "Чистая Ubuntu с драйвером".
    render(<TensorrtLlmSetupPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'providers:tensorrt.install' }))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'providers:tensorrt.plan.agree' })
    )

    await waitFor(() => expect(client.beginOperation).toHaveBeenCalledTimes(1))
    expect(client.beginOperation.mock.calls[0][1]).toMatchObject({
      kind: 'setup',
      descriptor_id: 'tensorrt-llm-1.2.1-r1',
    })

    coreSays(operation({ phase: 'awaiting-consent', revision: 2, plan_digest: digest }))
    await waitFor(() => expect(client.resumeOperation).toHaveBeenCalledWith('op-1', 2, digest))

    coreSays(
      operation({
        phase: 'preparing-host',
        revision: 3,
        pending_host_step: { step_id: 'step-1' } as EnvironmentOperation['pending_host_step'],
      })
    )
    await waitFor(() => expect(client.runHostStep).toHaveBeenCalledWith('op-1'))

    coreSays(operation({ phase: 'relogin-required', revision: 4 }))
    expect(await screen.findByText('providers:tensorrt.relogin.title')).toBeInTheDocument()
    // One prompt per step, however often the panel renders.
    expect(client.runHostStep).toHaveBeenCalledTimes(1)
  })

  it('does not approve a plan it did not show', async () => {
    // The machine changed between the probe and the consent: the core offers another plan.
    render(<TensorrtLlmSetupPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'providers:tensorrt.install' }))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'providers:tensorrt.plan.agree' })
    )
    await waitFor(() => expect(client.beginOperation).toHaveBeenCalled())

    const other = ('sha256:' + 'b'.repeat(64)) as RequirementPlan['plan_digest']
    client.probe.mockResolvedValue(plan({ plan_digest: other }))
    coreSays(operation({ phase: 'awaiting-consent', revision: 2, plan_digest: other }))

    // The new plan is shown for a fresh consent instead.
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(client.resumeOperation).not.toHaveBeenCalled()
  })

  it('finds a running pull as it is after the window was closed, with bytes and a cancel', async () => {
    // spec "Закрыли окно и открыли снова".
    seed(environment({ active_operation_id: 'op-1' }), [
      operation({
        phase: 'pulling-image',
        revision: 9,
        progress: { label: 'pull', completed: 5 * 1024 ** 3, total: 21 * 1024 ** 3, unit: 'bytes' },
      }),
    ])

    render(<TensorrtLlmSetupPanel />)

    expect(await screen.findByText('providers:tensorrt.phase.pulling-image')).toBeInTheDocument()
    expect(screen.getByText(/5\.0 GB/)).toBeInTheDocument()
    expect(screen.getByText(/21\.0 GB/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'providers:tensorrt.cancel' }))
    await waitFor(() => expect(client.cancelOperation).toHaveBeenCalledWith('op-1'))
  })

  it('shows where the image would go, what it needs and what is free, and offers no install without room', async () => {
    // spec "Нет места под образ".
    client.probe.mockResolvedValue(
      plan({
        availability: 'prerequisite-blocked',
        docker_root_dir: '/var/lib/docker',
        // The core reports the same number here as in the blocker's `params.free`.
        free_disk_bytes: 20 * 1024 ** 3,
        blockers: [
          {
            code: 'MANAGED_PREREQUISITE_BLOCKED',
            message: 'There is not enough free disk space for the runtime image.',
            reason: 'insufficient-disk',
            params: { free: String(20 * 1024 ** 3), required: String(63 * 1024 ** 3) },
          },
        ],
      })
    )

    render(<TensorrtLlmSetupPanel />)

    expect(await screen.findByText(/\/var\/lib\/docker/)).toBeInTheDocument()
    expect(screen.getByText(/63\.0 GB/)).toBeInTheDocument()
    expect(screen.getByText(/20\.0 GB/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'providers:tensorrt.install' })).not.toBeInTheDocument()
  })

  it('explains a card older than Ampere and checks again on request', async () => {
    // spec "Карта старше Ampere".
    client.probe.mockResolvedValue(
      plan({
        availability: 'prerequisite-blocked',
        blockers: [
          {
            code: 'MANAGED_PREREQUISITE_BLOCKED',
            message: 'Needs compute capability 8.0 or newer (Ampere+); the best card here has 7.5.',
            reason: 'compute-capability-too-low',
            params: { required: '8.0', actual: '7.5' },
          },
        ],
      })
    )

    render(<TensorrtLlmSetupPanel />)

    expect(
      await screen.findByText('providers:tensorrt.blocker.ampere {"required":"8.0","actual":"7.5"}')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'providers:tensorrt.checkAgain' }))
    await waitFor(() => expect(client.probe).toHaveBeenCalledTimes(2))
  })

  it('hands over the exact sudo command when there is no system prompt to show', async () => {
    client.runHostStep.mockResolvedValue({
      outcome: 'manual',
      command: 'sudo /run/user/1000/x/atomic-chat-core host-step exec /run/user/1000/x/step-1.request.json',
    })
    seed(environment({ active_operation_id: 'op-1' }), [
      operation({
        phase: 'preparing-host',
        revision: 3,
        pending_host_step: { step_id: 'step-1' } as EnvironmentOperation['pending_host_step'],
      }),
    ])

    render(<TensorrtLlmSetupPanel />)

    expect(
      await screen.findByText(
        'sudo /run/user/1000/x/atomic-chat-core host-step exec /run/user/1000/x/step-1.request.json'
      )
    ).toBeInTheDocument()
  })

  describe('on Windows (change add-tensorrt-llm-windows)', () => {
    const distributionPath = 'C:\\Users\\ann\\AppData\\Local\\AtomicChat\\wsl\\AtomicChat'
    const windowsPlan = () =>
      plan({
        recipe_id: 'linux.install-container-runtime',
        system_changes: [
          { code: 'enable-wsl', text: 'Turn on the Windows Subsystem for Linux (wsl --install --no-distribution).' },
          {
            code: 'import-distribution',
            text: `Download ubuntu 24.04 and import it as Atomic Chat’s own WSL distribution "AtomicChat" in ${distributionPath}.`,
            params: { name: 'AtomicChat', path: distributionPath },
          },
          {
            code: 'provision-distribution',
            text: 'Inside it, install Docker Engine and the NVIDIA Container Toolkit and generate the NVIDIA CDI specification.',
          },
        ],
        docker_root_dir: distributionPath,
        free_disk_bytes: 200 * 1024 ** 3,
        may_require_relogin: false,
        may_require_reboot: true,
      })
    const enableWsl = {
      step_id: 'step-w',
      action: 'windows.enable-wsl',
      recipe_id: 'windows.enable-wsl',
      parameters: {},
    } as unknown as EnvironmentOperation['pending_host_step']

    beforeEach(() => {
      seed(environment({ executor: 'wsl-docker' }))
      client.probe.mockResolvedValue(windowsPlan())
    })

    it('asks for UAC, then for a restart, and goes on after it with no new consent', async () => {
      // spec "Windows без WSL".
      render(<TensorrtLlmSetupPanel />)
      expect(await screen.findByText('providers:tensorrt.notInstalledWindows')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'providers:tensorrt.install' }))

      const dialog = await screen.findByRole('dialog')
      expect(within(dialog).getByText(/wsl --install --no-distribution/)).toBeInTheDocument()
      expect(within(dialog).getByText(/import it as Atomic Chat’s own WSL distribution/)).toBeInTheDocument()
      expect(within(dialog).getByText(/install Docker Engine and the NVIDIA Container Toolkit/)).toBeInTheDocument()
      expect(within(dialog).getByText('providers:tensorrt.plan.reboot')).toBeInTheDocument()
      expect(within(dialog).queryByText('providers:tensorrt.plan.relogin')).not.toBeInTheDocument()
      // The mock `t` prints its parameters as JSON, which doubles the path's backslashes.
      const disk = within(dialog).getByText(/providers:tensorrt.plan.wslDisk /)
      expect(disk).toHaveTextContent(JSON.stringify(distributionPath).slice(1, -1))
      expect(disk).toHaveTextContent('"free":"200.0 GB"')
      fireEvent.click(within(dialog).getByRole('button', { name: 'providers:tensorrt.plan.agree' }))
      await waitFor(() => expect(client.beginOperation).toHaveBeenCalledTimes(1))

      coreSays(operation({ phase: 'awaiting-consent', revision: 2, plan_digest: digest }))
      await waitFor(() => expect(client.resumeOperation).toHaveBeenCalledWith('op-1', 2, digest))

      let answer: (value: unknown) => void = () => {}
      client.runHostStep.mockReturnValue(new Promise((resolve) => (answer = resolve)))
      coreSays(operation({ phase: 'preparing-host', revision: 3, pending_host_step: enableWsl }))
      await waitFor(() => expect(client.runHostStep).toHaveBeenCalledWith('op-1'))
      expect(screen.getByText('providers:tensorrt.phaseWindows.preparing-host')).toBeInTheDocument()
      expect(screen.getByText('providers:tensorrt.hostStep.uac.waiting')).toBeInTheDocument()

      await act(async () => answer({ outcome: 'reboot-required', log_tail: '' }))
      coreSays(operation({ phase: 'reboot-required', revision: 4, completed_step_ids: ['step-w'] }))
      expect(await screen.findByText('providers:tensorrt.reboot.title')).toBeInTheDocument()
      expect(screen.getByText('providers:tensorrt.reboot.body')).toBeInTheDocument()

      // After the restart: a new core, the same operation going on by itself.
      act(() => {
        store().applySnapshot({
          instance_id: 'core-b',
          environments: [environment({ executor: 'wsl-docker', instance_id: 'core-b', active_operation_id: 'op-1' })],
          environment_operations: [
            operation({ instance_id: 'core-b', phase: 'preparing-environment', revision: 5, completed_step_ids: ['step-w'] }),
          ],
        })
      })
      expect(await screen.findByText('providers:tensorrt.phaseWindows.preparing-environment')).toBeInTheDocument()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(client.resumeOperation).toHaveBeenCalledTimes(1)
      expect(client.runHostStep).toHaveBeenCalledTimes(1)
    })

    it('where UAC cannot be raised, hands over the command for an administrator terminal and checks again on request', async () => {
      client.runHostStep.mockResolvedValue({ outcome: 'manual', command: 'wsl --install --no-distribution' })
      seed(environment({ executor: 'wsl-docker', active_operation_id: 'op-1' }), [
        operation({ phase: 'preparing-host', revision: 3, pending_host_step: enableWsl }),
      ])

      render(<TensorrtLlmSetupPanel />)

      expect(await screen.findByText('wsl --install --no-distribution')).toBeInTheDocument()
      expect(screen.getByText('providers:tensorrt.hostStep.uac.manual')).toBeInTheDocument()
      const probes = client.probe.mock.calls.length
      fireEvent.click(screen.getByRole('button', { name: 'providers:tensorrt.checkAgain' }))
      await waitFor(() => expect(client.cancelOperation).toHaveBeenCalledWith('op-1'))
      await waitFor(() => expect(client.probe.mock.calls.length).toBe(probes + 1))
    })
  })

  it('answers a removal still waiting for consent with the removal dialog, not a setup plan', async () => {
    // The page was left while the core prepared the removal: nothing here remembers the consent.
    seed(environment({ installations: [installedEngine], active_operation_id: 'op-1' }), [
      operation({ kind: 'remove', phase: 'awaiting-consent', revision: 2, plan_digest: digest }),
    ])

    render(<TensorrtLlmSetupPanel />)

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('providers:tensorrt.remove.title')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'providers:tensorrt.remove.confirm' }))
    await waitFor(() => expect(client.resumeOperation).toHaveBeenCalledWith('op-1', 2, digest))
    expect(client.beginOperation).not.toHaveBeenCalled()
  })

  describe('a setup that failed on a descriptor conf has since replaced', () => {
    const oldDigest = ('sha256:' + 'b'.repeat(64)) as RequirementPlan['plan_digest']
    const failedOnR2 = () =>
      operation({
        phase: 'failed',
        revision: 7,
        approved_plan_digest: oldDigest,
        error: {
          code: 'MANAGED_PREREQUISITE_BLOCKED',
          message: 'The NVIDIA libraries Windows provides to WSL are version 615.41, older than the 615.65.02 TensorRT-LLM needs.',
        },
      })

    it('offers a new setup with the current plan next to Try again, and starts it with the new descriptor', async () => {
      // NVIDIA Windows on Arm, 2026-10-06: r3 lowered the driver floor, but Try again resumed the r2 setup.
      client.probe.mockResolvedValue(plan({ descriptor_id: 'tensorrt-llm-1.3.0rc29-r3' }))
      seed(environment(), [failedOnR2()])
      render(<TensorrtLlmSetupPanel />)

      expect(await screen.findByText(/older than the 615\.65\.02/)).toBeInTheDocument()
      expect(await screen.findByText('providers:tensorrt.newerPlan')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'providers:tensorrt.retry' })).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'providers:tensorrt.install' }))
      fireEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'providers:tensorrt.plan.agree' })
      )

      await waitFor(() => expect(client.beginOperation).toHaveBeenCalledTimes(1))
      expect(client.beginOperation.mock.calls[0][1]).toMatchObject({
        kind: 'setup',
        descriptor_id: 'tensorrt-llm-1.3.0rc29-r3',
      })
      expect(client.resumeOperation).not.toHaveBeenCalled()
    })

    it('offers only Try again while the current plan is the one that failed', async () => {
      client.probe.mockResolvedValue(plan({ plan_digest: oldDigest }))
      seed(environment(), [failedOnR2()])
      render(<TensorrtLlmSetupPanel />)

      expect(await screen.findByRole('button', { name: 'providers:tensorrt.retry' })).toBeInTheDocument()
      await waitFor(() => expect(client.probe).toHaveBeenCalled())
      expect(screen.queryByRole('button', { name: 'providers:tensorrt.install' })).not.toBeInTheDocument()
      expect(screen.queryByText('providers:tensorrt.newerPlan')).not.toBeInTheDocument()
    })
  })

  it('shows why the privileged step failed, not only that it did, even after the page opens again', async () => {
    // Manual run F-2: the screen said only "Preparing the system did not finish".
    client.runHostStep.mockResolvedValue({
      outcome: 'failed',
      log_tail: 'docker-service failed (exit 1): all predefined address pools have been fully subnetted',
    })
    seed(environment({ active_operation_id: 'op-1' }), [
      operation({
        phase: 'preparing-host',
        revision: 3,
        pending_host_step: { step_id: 'step-f2' } as EnvironmentOperation['pending_host_step'],
      }),
    ])
    const first = render(<TensorrtLlmSetupPanel />)
    await waitFor(() => expect(client.runHostStep).toHaveBeenCalled())
    coreSays(
      operation({
        phase: 'failed',
        revision: 4,
        error: { code: 'MANAGED_HOST_STEP_FAILED', message: 'Preparing the system did not finish.' },
      })
    )
    expect(await screen.findByText(/fully subnetted/)).toBeInTheDocument()
    first.unmount()

    render(<TensorrtLlmSetupPanel />)

    expect(await screen.findByText(/docker-service failed \(exit 1\)/)).toBeInTheDocument()
  })

  it('suggests a restart when signing out and in did not bring the docker group', async () => {
    // Manual run F-7: a user systemd that outlives the sign-out keeps the old groups.
    seed(environment({ active_operation_id: 'op-1' }), [
      operation({ phase: 'relogin-required', revision: 5 }),
    ])

    render(<TensorrtLlmSetupPanel />)

    expect(await screen.findByText('providers:tensorrt.relogin.title')).toBeInTheDocument()
    expect(screen.getByText('providers:tensorrt.relogin.stillWaiting')).toBeInTheDocument()
  })

  it('never asks for the system password twice for one step, even after the page opens again', async () => {
    let finish!: (answer: { outcome: string }) => void
    client.runHostStep.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    seed(environment({ active_operation_id: 'op-1' }), [
      operation({
        phase: 'preparing-host',
        revision: 3,
        pending_host_step: { step_id: 'step-9' } as EnvironmentOperation['pending_host_step'],
      }),
    ])

    const first = render(<TensorrtLlmSetupPanel />)
    await waitFor(() => expect(client.runHostStep).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'providers:tensorrt.hostStep.retry' })).toBeDisabled()
    first.unmount()
    render(<TensorrtLlmSetupPanel />)
    await screen.findByText('providers:tensorrt.phase.preparing-host')

    expect(client.runHostStep).toHaveBeenCalledTimes(1)
    finish({ outcome: 'declined' })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'providers:tensorrt.hostStep.retry' })).toBeEnabled()
    )
  })

  it('says what removing the engine frees, that uninstalling the app does not, and keeps models by default', async () => {
    seed(environment({ installations: [installedEngine] }))

    render(<TensorrtLlmSetupPanel />)

    expect(await screen.findByText(/providers:tensorrt.remove.space/)).toHaveTextContent('63.0 GB')
    fireEvent.click(screen.getByRole('button', { name: 'providers:tensorrt.remove.button' }))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'providers:tensorrt.remove.confirm' })
    )
    await waitFor(() =>
      expect(client.beginOperation.mock.calls[0][1]).toMatchObject({ kind: 'remove', retain_models: true })
    )

    // The person confirmed exactly this removal; the core's consent step is approved as it asks.
    coreSays(operation({ kind: 'remove', phase: 'awaiting-consent', revision: 2, plan_digest: digest }))
    await waitFor(() => expect(client.resumeOperation).toHaveBeenCalledWith('op-1', 2, digest))
  })

  describe('removing the environment on Windows (change add-tensorrt-llm-windows)', () => {
    const distribution = {
      name: 'AtomicChat',
      path: 'C:\\Users\\ann\\AppData\\Local\\AtomicChat\\wsl\\AtomicChat',
      size_bytes: 42 * 1024 ** 3,
    }
    const windowsEnvironment = (overrides: Partial<EnvironmentSnapshot> = {}) =>
      environment({ executor: 'wsl-docker', distribution, ...overrides })

    beforeEach(() => {
      useModelProvider.setState({
        providers: [
          {
            active: true,
            provider: 'tensorrt-llm',
            settings: [],
            models: [{ id: 'nvidia/Qwen3-8B-FP8' }, { id: 'Qwen/Qwen3-4B' }],
          },
        ] as never,
      })
    })

    it('offers it once the engine is gone, says the app’s uninstall leaves it, and removes it after a consent naming the models and the space', async () => {
      // spec "Удаление окружения на Windows".
      seed(windowsEnvironment())
      render(<TensorrtLlmSetupPanel />)

      expect(await screen.findByText(/providers:tensorrt.removeEnvironment.hint/)).toHaveTextContent('42.0 GB')
      fireEvent.click(screen.getByRole('button', { name: 'providers:tensorrt.removeEnvironment.button' }))

      const dialog = await screen.findByRole('dialog')
      expect(within(dialog).getByText(/providers:tensorrt.removeEnvironment.body/)).toHaveTextContent('42.0 GB')
      expect(within(dialog).getByText('nvidia/Qwen3-8B-FP8')).toBeInTheDocument()
      expect(within(dialog).getByText('Qwen/Qwen3-4B')).toBeInTheDocument()
      fireEvent.click(within(dialog).getByRole('button', { name: 'providers:tensorrt.removeEnvironment.confirm' }))

      await waitFor(() => expect(client.beginOperation).toHaveBeenCalledTimes(1))
      expect(client.beginOperation.mock.calls[0][1]).toMatchObject({
        kind: 'remove',
        target: { kind: 'environment' },
      })

      const removal = operation({
        kind: 'remove',
        target: { kind: 'environment' },
        phase: 'awaiting-consent',
        revision: 2,
        plan_digest: digest,
      })
      coreSays(removal)
      await waitFor(() => expect(client.resumeOperation).toHaveBeenCalledWith('op-1', 2, digest))
      coreSays({ ...removal, phase: 'removing', revision: 3 })
      expect(await screen.findByText('providers:tensorrt.removeEnvironment.removing')).toBeInTheDocument()
      // Not the engine's removal dialog, and no second consent.
      expect(screen.queryByText('providers:tensorrt.remove.title')).not.toBeInTheDocument()

      // Gone: the page asks the machine again and offers the install, import included.
      const probes = client.probe.mock.calls.length
      act(() => {
        store().applyEnvironment(
          windowsEnvironment({ distribution: null, revision: 200, active_operation_id: null })
        )
        store().applyOperation({ ...removal, phase: 'removed', revision: 4 })
      })
      await waitFor(() => expect(client.probe.mock.calls.length).toBe(probes + 1))
      expect(await screen.findByRole('button', { name: 'providers:tensorrt.install' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'providers:tensorrt.removeEnvironment.button' })).not.toBeInTheDocument()
    })

    it('is not offered while the engine is installed, and the engine’s removal says the distribution stays', async () => {
      seed(windowsEnvironment({ installations: [installedEngine] }))
      render(<TensorrtLlmSetupPanel />)

      expect(await screen.findByText(/providers:tensorrt.remove.spaceWindows/)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'providers:tensorrt.removeEnvironment.button' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'providers:tensorrt.remove.button' }))
      expect(await screen.findByText('providers:tensorrt.remove.bodyWindows')).toBeInTheDocument()
    })

    it('says why a removal of the environment failed', async () => {
      // Review finding: a failed removal must not just vanish.
      seed(windowsEnvironment(), [
        operation({
          kind: 'remove',
          target: { kind: 'environment' },
          phase: 'failed',
          revision: 5,
          error: { code: 'MANAGED_PREREQUISITE_BLOCKED', message: 'wsl --unregister AtomicChat failed (exit 1).' },
        }),
      ])
      render(<TensorrtLlmSetupPanel />)

      expect(await screen.findByText('wsl --unregister AtomicChat failed (exit 1).')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'providers:tensorrt.removeEnvironment.button' })).toBeInTheDocument()
    })

    it('reviews a removal waiting for consent with the removal’s own dialog, not the install plan', async () => {
      seed(windowsEnvironment({ active_operation_id: 'op-1' }), [
        operation({ kind: 'remove', target: { kind: 'environment' }, phase: 'awaiting-consent', revision: 2, plan_digest: digest }),
      ])
      render(<TensorrtLlmSetupPanel />)
      const first = await screen.findByRole('dialog')
      fireEvent.click(within(first).getByRole('button', { name: 'providers:tensorrt.plan.cancel' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

      fireEvent.click(screen.getByRole('button', { name: 'providers:tensorrt.consent.review' }))

      const dialog = await screen.findByRole('dialog')
      expect(within(dialog).getByText('providers:tensorrt.removeEnvironment.title')).toBeInTheDocument()
      expect(within(dialog).queryByText('providers:tensorrt.plan.title')).not.toBeInTheDocument()
    })

    it('is not offered before the distribution exists, nor on Linux', async () => {
      seed(environment({ executor: 'wsl-docker', distribution: null }))
      const { unmount } = render(<TensorrtLlmSetupPanel />)
      expect(await screen.findByRole('button', { name: 'providers:tensorrt.install' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'providers:tensorrt.removeEnvironment.button' })).not.toBeInTheDocument()
      unmount()

      seed(environment())
      render(<TensorrtLlmSetupPanel />)
      expect(await screen.findByRole('button', { name: 'providers:tensorrt.install' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'providers:tensorrt.removeEnvironment.button' })).not.toBeInTheDocument()
    })
  })
})
