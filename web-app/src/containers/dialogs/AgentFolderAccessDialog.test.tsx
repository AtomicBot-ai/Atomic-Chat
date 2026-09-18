import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AgentFolderAccessDialog from './AgentFolderAccessDialog'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useAgentRun } from '@/hooks/useAgentRun'
import { useThreads } from '@/hooks/useThreads'

const resolveAgentFolderAccess = vi.hoisted(() => vi.fn())
const resolveAgentWorkspaceRoot = vi.hoisted(() => vi.fn())

vi.mock('@/services/agent/tauri', () => ({
  resolveAgentFolderAccess,
  resolveAgentWorkspaceRoot,
  isStaleAgentFolderAccessError: () => false,
  resolveAgentApproval: vi.fn(),
  isStaleAgentApprovalError: () => false,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const THREAD = 'background-thread'

function openRequest() {
  useAgentRun.getState().startRun(THREAD, 'run-1')
  useAgentRun.getState().applyEvent(THREAD, {
    type: 'folder_access_requested',
    run_id: 'run-1',
    access_id: 'access-1',
    tool: 'os.fs.write',
    path: '/Users/me/Desktop',
    display_name: 'Desktop',
    root_id: 'desktop',
    reason: 'outside the workspace',
  })
}

describe('AgentFolderAccessDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveAgentFolderAccess.mockResolvedValue(undefined)
    resolveAgentWorkspaceRoot.mockResolvedValue({
      rootId: 'desktop',
      path: '/Users/me/Desktop',
      name: 'Desktop',
    })
    useAgentRun.getState().clearAll()
    useAgentMode.getState().clearAll()
    useThreads.setState({ currentThreadId: 'another-thread' })
    act(openRequest)
  })

  it('offers primary Allow, Always Allow, and Deny', () => {
    render(<AgentFolderAccessDialog />)

    const allow = screen.getByRole('button', {
      name: 'agentFolderAccess.allow',
    })
    expect(allow).toHaveAttribute('data-variant', 'default')
    expect(
      screen.getByRole('button', {
        name: 'agentFolderAccess.alwaysAllow',
      })
    ).toHaveAttribute('data-variant', 'outline')
    expect(
      screen.getByRole('button', { name: 'agentFolderAccess.deny' })
    ).toHaveAttribute('data-variant', 'ghost')
  })

  it('keeps Allow temporary and persists only Always Allow', async () => {
    const first = render(<AgentFolderAccessDialog />)
    fireEvent.click(
      screen.getByRole('button', { name: 'agentFolderAccess.allow' })
    )
    await waitFor(() => expect(resolveAgentFolderAccess).toHaveBeenCalled())
    expect(resolveAgentWorkspaceRoot).not.toHaveBeenCalled()
    first.unmount()

    vi.clearAllMocks()
    resolveAgentFolderAccess.mockResolvedValue(undefined)
    act(openRequest)
    render(<AgentFolderAccessDialog />)
    fireEvent.click(
      screen.getByRole('button', {
        name: 'agentFolderAccess.alwaysAllow',
      })
    )

    await waitFor(() =>
      expect(resolveAgentWorkspaceRoot).toHaveBeenCalledWith(
        '/Users/me/Desktop'
      )
    )
    expect(useAgentMode.getState().getWorkspace(THREAD).externalRoots).toEqual([
      {
        rootId: 'desktop',
        path: '/Users/me/Desktop',
        name: 'Desktop',
        canEdit: true,
      },
    ])
  })
})
