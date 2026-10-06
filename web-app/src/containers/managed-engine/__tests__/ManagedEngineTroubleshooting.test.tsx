import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn() }))
vi.mock('@/lib/clipboard', () => clipboard)

const client = vi.hoisted(() => ({
  probe: vi.fn(),
  resetEnvironment: vi.fn(),
  environmentDiagnostics: vi.fn(),
  readManagedSnapshot: vi.fn(),
}))
vi.mock('@/services/managed-environment/client', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/services/managed-environment/client')
  >()),
  ...client,
}))

import { ManagedEngineTroubleshooting } from '../ManagedEngineTroubleshooting'
import { TENSORRT_LLM_ENGINE } from '@/lib/managed-engines'
import { resetManagedPlansForTests } from '@/hooks/useManagedPlan'
import { useManagedEnvironmentStore } from '@/stores/managed-environment-store'
import type {
  EnvironmentOperation,
  EnvironmentSnapshot,
} from '@/services/managed-environment/types'

function environment(
  overrides: Partial<EnvironmentSnapshot> = {}
): EnvironmentSnapshot {
  return {
    schema_version: 1,
    environment_id: 'default',
    instance_id: 'core-a',
    revision: 1,
    executor: 'wsl-docker',
    availability: 'setup-required',
    gpus: [],
    blockers: [],
    selinux: null,
    installations: [],
    active_operation_id: null,
    minimum_app_version: null,
    ...overrides,
  }
}

const failedSetup = {
  schema_version: 1,
  operation_id: 'op-failed',
  request_id: 'req-1',
  environment_id: 'default',
  target: {
    kind: 'runtime',
    installation_id: 'tensorrt-llm',
    engine_id: 'tensorrt-llm',
  },
  kind: 'setup',
  instance_id: 'core-a',
  revision: 4,
  phase: 'failed',
  plan_digest: null,
  approved_plan_digest: null,
  carried_plan_digest: null,
  progress: null,
  pending_host_step: null,
  completed_step_ids: [],
  cancellation_requested: false,
  error: { code: 'MANAGED_PREREQUISITE_BLOCKED', message: 'driver too old' },
} as unknown as EnvironmentOperation

const seed = (
  env: EnvironmentSnapshot,
  operations: EnvironmentOperation[] = []
) =>
  useManagedEnvironmentStore
    .getState()
    .applySnapshot({
      instance_id: 'core-a',
      environments: [env],
      environment_operations: operations,
    })

beforeEach(() => {
  vi.clearAllMocks()
  useManagedEnvironmentStore.getState().reset()
  resetManagedPlansForTests()
  client.probe.mockResolvedValue({ plan_digest: 'sha256:x', blockers: [] })
})

describe('ManagedEngineTroubleshooting', () => {
  it('shows nothing before the core has described an environment', () => {
    const { container } = render(<ManagedEngineTroubleshooting engine={TENSORRT_LLM_ENGINE} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names a pinned conf source, the cause that hides every newer descriptor', () => {
    seed(
      environment({
        source_overrides: [
          {
            variable: 'ATOMIC_RUNTIME_DESCRIPTOR_URL',
            value: 'https://raw/conf/bbcc7ec/tensorrt-llm.json',
          },
        ],
      })
    )
    render(<ManagedEngineTroubleshooting engine={TENSORRT_LLM_ENGINE} />)
    expect(
      screen.getByText('providers:tensorrt.troubleshooting.overridesTitle')
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'ATOMIC_RUNTIME_DESCRIPTOR_URL=https://raw/conf/bbcc7ec/tensorrt-llm.json'
      )
    ).toBeInTheDocument()
  })

  it('copies the core report to the clipboard', async () => {
    seed(environment())
    client.environmentDiagnostics.mockResolvedValue({ core_version: '0.9.6' })
    clipboard.copyToClipboard.mockResolvedValue(true)
    render(<ManagedEngineTroubleshooting engine={TENSORRT_LLM_ENGINE} />)

    fireEvent.click(screen.getByText('providers:tensorrt.troubleshooting.copy'))

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(client.environmentDiagnostics).toHaveBeenCalledWith('default')
    // What reaches the clipboard is the core's report itself, readable as JSON.
    const [copied] = clipboard.copyToClipboard.mock.calls[0] as [string]
    expect(JSON.parse(copied)).toEqual({ core_version: '0.9.6' })
    expect(copied).toContain('\n  "core_version"')
  })

  it('after a failed setup, starts over: resets, takes the snapshot again and probes afresh', async () => {
    seed(environment(), [failedSetup])
    client.resetEnvironment.mockResolvedValue({
      environment_id: 'default',
      archived_operation_ids: ['op-failed'],
      archive_path: 'C:/x',
    })
    client.readManagedSnapshot.mockResolvedValue({
      instance_id: 'core-a',
      environments: [environment({ revision: 2 })],
      environment_operations: [],
    })
    render(<ManagedEngineTroubleshooting engine={TENSORRT_LLM_ENGINE} />)

    fireEvent.click(
      screen.getByText('providers:tensorrt.troubleshooting.startOver')
    )
    fireEvent.click(
      screen.getByText('providers:tensorrt.troubleshooting.confirm')
    )

    await waitFor(() => expect(client.probe).toHaveBeenCalled())
    expect(client.resetEnvironment).toHaveBeenCalledWith('default')
    expect(
      Object.keys(useManagedEnvironmentStore.getState().operations)
    ).toEqual([])
    expect(toast.success).toHaveBeenCalled()
  })

  it('cannot reset while an operation runs', () => {
    seed(environment({ active_operation_id: 'op-1' }))
    render(<ManagedEngineTroubleshooting engine={TENSORRT_LLM_ENGINE} />)
    expect(
      screen.getByText('providers:tensorrt.troubleshooting.reset')
    ).toBeDisabled()
  })
})
