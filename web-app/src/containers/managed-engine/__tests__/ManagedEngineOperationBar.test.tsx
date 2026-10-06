import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { OperationBarView } from '../ManagedEngineOperationBar'
import type { EnvironmentOperation } from '@/services/managed-environment/types'

const operation = (over: Partial<EnvironmentOperation> = {}): EnvironmentOperation => ({
  schema_version: 1,
  operation_id: 'op-1',
  request_id: 'req-1',
  environment_id: 'default',
  target: { kind: 'runtime', installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' },
  kind: 'setup',
  instance_id: 'core-1',
  revision: 3,
  phase: 'pulling-image',
  plan_digest: null,
  approved_plan_digest: null,
  carried_plan_digest: null,
  progress: null,
  pending_host_step: null,
  completed_step_ids: [],
  cancellation_requested: false,
  error: null,
  ...over,
})

describe('ManagedEngineOperationBar', () => {
  beforeEach(() => {
    invoke.mockReset()
    navigate.mockReset()
  })

  it('shows progress without any session button while the image downloads', () => {
    render(
      <OperationBarView
        operation={operation({ progress: { label: 'pull', completed: 512, total: 1024, unit: 'bytes' } })}
        windows={false}
        onDismiss={() => {}}
      />
    )
    expect(screen.getByText('providers:tensorrt.phase.pulling-image')).toBeInTheDocument()
    expect(screen.queryByText('providers:tensorrt.bar.restartNow')).toBeNull()
    expect(screen.queryByText('providers:tensorrt.bar.signOutNow')).toBeNull()
  })

  it('says the UAC step takes minutes instead of looking stuck', () => {
    render(
      <OperationBarView
        operation={operation({
          phase: 'preparing-host',
          pending_host_step: { action: 'windows.enable-wsl' } as EnvironmentOperation['pending_host_step'],
        })}
        windows
        onDismiss={() => {}}
      />
    )
    expect(screen.getByText('providers:tensorrt.bar.hostStepWindows')).toBeInTheDocument()
  })

  it('after the UAC approval says WSL is being installed, not "approve"', () => {
    render(
      <OperationBarView
        operation={operation({
          phase: 'preparing-host',
          pending_host_step: { step_id: 's-1', action: 'windows.enable-wsl' } as EnvironmentOperation['pending_host_step'],
        })}
        windows
        hostStepRunning
        onDismiss={() => {}}
      />
    )
    expect(screen.getByText('providers:tensorrt.hostStep.uac.running')).toBeInTheDocument()
    expect(screen.queryByText('providers:tensorrt.bar.hostStepWindows')).toBeNull()
  })

  it('offers "restart now" on Windows only when a restart is required, and runs it', () => {
    render(<OperationBarView operation={operation({ phase: 'reboot-required' })} windows onDismiss={() => {}} />)
    expect(screen.getByText('providers:tensorrt.bar.reboot')).toBeInTheDocument()
    expect(screen.queryByText('providers:tensorrt.bar.signOutNow')).toBeNull()
    fireEvent.click(screen.getByText('providers:tensorrt.bar.restartNow'))
    expect(invoke).toHaveBeenCalledWith('atomic_core_finish_session_step', { action: 'restart' })
  })

  it('offers "sign out now" on Linux only when a new sign-in is required, and runs it', () => {
    render(
      <OperationBarView operation={operation({ phase: 'relogin-required' })} windows={false} onDismiss={() => {}} />
    )
    expect(screen.getByText('providers:tensorrt.bar.relogin')).toBeInTheDocument()
    expect(screen.queryByText('providers:tensorrt.bar.restartNow')).toBeNull()
    fireEvent.click(screen.getByText('providers:tensorrt.bar.signOutNow'))
    expect(invoke).toHaveBeenCalledWith('atomic_core_finish_session_step', { action: 'sign-out' })
  })

  it('shows why the restart failed and lets the person try again', async () => {
    invoke.mockRejectedValueOnce(new Error('shutdown.exe: access denied'))
    render(<OperationBarView operation={operation({ phase: 'reboot-required' })} windows onDismiss={() => {}} />)
    fireEvent.click(screen.getByText('providers:tensorrt.bar.restartNow'))
    expect(await screen.findByText('providers:tensorrt.bar.actionFailed')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('providers:tensorrt.bar.restartNow').closest('button')).toBeEnabled())
  })

  it('"Later" dismisses the bar for this step without restarting anything', () => {
    const onDismiss = vi.fn()
    render(<OperationBarView operation={operation({ phase: 'reboot-required' })} windows onDismiss={onDismiss} />)
    // Both the text button and the close icon (labelled "Later") dismiss.
    const controls = screen.getAllByRole('button', { name: 'providers:tensorrt.bar.later' })
    expect(controls).toHaveLength(2)
    for (const control of controls) fireEvent.click(control)
    expect(onDismiss).toHaveBeenCalledTimes(2)
    expect(invoke).not.toHaveBeenCalled()
  })
})
