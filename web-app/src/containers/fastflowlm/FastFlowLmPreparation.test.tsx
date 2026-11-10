import { act } from '@testing-library/react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { FastFlowLmPreparation } from './FastFlowLmPreparation'
import {
  fastFlowLmOperations,
  probeFastFlowLm,
  resumeFastFlowLmPreparation,
} from '@/services/fastflowlm/core'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/services/fastflowlm/core', () => ({
  probeFastFlowLm: vi.fn(),
  fastFlowLmOperations: vi.fn(),
  beginFastFlowLmPreparation: vi.fn(),
  consentFastFlowLmPreparation: vi.fn(),
  cancelFastFlowLmPreparation: vi.fn(),
  resumeFastFlowLmPreparation: vi.fn(),
  fastFlowLmOperation: vi.fn(),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fastFlowLmOperations).mockResolvedValue([])
})

it('shows core driver guidance and retries only the read-only probe', async () => {
  vi.mocked(probeFastFlowLm).mockResolvedValue({
    status: 'blocked',
    blockers: ['driver-missing'],
    driver_setup: {
      title: 'Install the AMD driver',
      steps: ['Restart afterwards'],
      commands: [],
      links: [{ label: 'AMD', url: 'https://www.amd.com/en/support' }],
    },
  } as never)
  render(<FastFlowLmPreparation />)
  expect(await screen.findByText('Install the AMD driver')).toBeVisible()
  expect(screen.getByRole('link', { name: 'AMD' })).toHaveAttribute(
    'href',
    'https://www.amd.com/en/support'
  )
  fireEvent.click(
    screen.getByRole('button', { name: 'providers:fastflowlm.checkAgain' })
  )
  await waitFor(() => expect(probeFastFlowLm).toHaveBeenCalledTimes(2))
  expect(
    screen.queryByRole('button', { name: 'providers:fastflowlm.prepare' })
  ).not.toBeInTheDocument()
})

it('keeps readiness separate from a supported engine installation', async () => {
  vi.mocked(probeFastFlowLm).mockResolvedValue({
    status: 'blocked',
    blockers: ['xdna2-not-found'],
  } as never)
  render(<FastFlowLmPreparation />)
  expect(
    await screen.findByText('providers:fastflowlm.blockers.xdna2-not-found')
  ).toBeVisible()
  expect(
    screen.queryByText('providers:fastflowlm.ready')
  ).not.toBeInTheDocument()
})

it('keeps a recovery action for an authorized helper after reopening', async () => {
  vi.mocked(probeFastFlowLm).mockResolvedValue({
    status: 'blocked',
    blockers: [],
  } as never)
  vi.mocked(fastFlowLmOperations).mockResolvedValue([
    {
      operation_id: 'op-1',
      revision: 3,
      state: 'preparing-host',
      pending_host_step: null,
      plan: { changes: [] },
    },
  ] as never)
  render(<FastFlowLmPreparation />)
  expect(
    await screen.findByRole('button', { name: 'providers:fastflowlm.continue' })
  ).toBeEnabled()
})

it('recovers the same bound manual authorization and displays its exact command without executing it', async () => {
  const op = {
    operation_id: 'op-1',
    revision: 3,
    state: 'preparing-host',
    pending_host_step: { step_id: 'step-1' },
    plan: { changes: [] },
  }
  vi.mocked(probeFastFlowLm).mockResolvedValue({
    status: 'blocked',
    blockers: [],
  } as never)
  vi.mocked(fastFlowLmOperations).mockResolvedValue([op] as never)
  vi.mocked(resumeFastFlowLmPreparation).mockResolvedValue(op as never)
  vi.mocked(invoke).mockResolvedValue({
    ...op,
    desktop_host_step: {
      kind: 'manual',
      command:
        "'/bin/sh' '/runtime/authorize.sh' '--request-sha256' 'bound-digest'",
    },
  })
  render(<FastFlowLmPreparation />)
  fireEvent.click(
    await screen.findByRole('button', { name: 'providers:fastflowlm.continue' })
  )
  expect(
    await screen.findByText('providers:fastflowlm.authorization.manual')
  ).toBeVisible()
  expect(screen.getByText(/authorize.sh/).tagName).toBe('PRE')
  expect(invoke).toHaveBeenCalledWith('atomic_fastflowlm_run_host_step', {
    operationId: 'op-1',
  })
  expect(invoke).toHaveBeenCalledTimes(1)
})

it('keeps a newer core snapshot when a terminal helper reply arrives late', async () => {
  const op = {
    operation_id: 'op-1',
    revision: 3,
    state: 'preparing-host',
    pending_host_step: { step_id: 'step-1' },
    plan: { changes: [] },
  }
  vi.mocked(probeFastFlowLm).mockResolvedValue({
    status: 'blocked',
    blockers: [],
  } as never)
  vi.mocked(fastFlowLmOperations).mockResolvedValue([op] as never)
  vi.mocked(resumeFastFlowLmPreparation).mockResolvedValue(op as never)
  let finish!: (value: unknown) => void
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  render(<FastFlowLmPreparation />)
  fireEvent.click(
    await screen.findByRole('button', { name: 'providers:fastflowlm.continue' })
  )
  await waitFor(() => expect(invoke).toHaveBeenCalled())
  const operationListener = vi
    .mocked(listen)
    .mock.calls.find(
      ([name]) => name === 'atomic-core://fastflowlm:operation'
    )![1]
  await act(async () => {
    operationListener({
      payload: { ...op, state: 'ready', revision: 4, pending_host_step: null },
    } as never)
    finish({
      ...op,
      desktop_host_step: { kind: 'manual', command: 'old command' },
    })
  })
  expect(screen.getByText('providers:fastflowlm.operation.ready')).toBeVisible()
  expect(screen.queryByText('old command')).not.toBeInTheDocument()
})
