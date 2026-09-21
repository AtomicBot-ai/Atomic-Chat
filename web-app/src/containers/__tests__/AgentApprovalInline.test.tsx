import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AgentApprovalInline from '@/containers/AgentApprovalInline'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useAgentRun } from '@/hooks/useAgentRun'

const resolveAgentApproval = vi.hoisted(() => vi.fn())
const resolveAgentFolderAccess = vi.hoisted(() => vi.fn())
const resolveAgentWorkspaceRoot = vi.hoisted(() => vi.fn())

vi.mock('@/services/agent/tauri', () => ({
  resolveAgentApproval,
  resolveAgentFolderAccess,
  resolveAgentWorkspaceRoot,
  isStaleAgentApprovalError: () => false,
  isStaleAgentFolderAccessError: () => false,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const THREAD = 'thread-1'

const approvalEvent = {
  type: 'approval_requested' as const,
  run_id: 'run-1',
  approval_id: 'approval-1',
  tool: 'mcp.github.create_issue',
  reason: 'tool is approval-gated',
  preview: { args: '{"title":"bug"}' },
  affected_resources: [
    { kind: 'mcp', value: 'mcp.github.create_issue', operation: 'call' },
  ],
  can_remember: true,
}

const openFolderAccess = () => {
  useAgentRun.getState().startRun(THREAD, 'run-1')
  useAgentRun.getState().applyEvent(THREAD, {
    type: 'folder_access_requested',
    run_id: 'run-1',
    access_id: 'access-1',
    tool: 'os.fs.read',
    path: '/Users/me/project',
    display_name: 'project',
    root_id: 'root-1',
    reason: 'outside the workspace',
  })
}

describe('AgentApprovalInline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveAgentApproval.mockResolvedValue(undefined)
    useAgentRun.getState().clearAll()
    useAgentMode.getState().clearAll()
  })

  it('renders nothing without a pending request', () => {
    render(<AgentApprovalInline threadId={THREAD} />)
    expect(
      screen.queryByTestId('agent-approval-inline')
    ).not.toBeInTheDocument()
  })

  it('shows the pending approval and resolves an approve-once click', async () => {
    act(() => {
      useAgentRun.getState().startRun(THREAD, 'run-1')
      useAgentRun.getState().applyEvent(THREAD, approvalEvent)
    })
    render(<AgentApprovalInline threadId={THREAD} />)

    expect(screen.getByTestId('agent-approval-inline')).toBeInTheDocument()
    expect(screen.getByText('agentApproval.title')).toBeInTheDocument()
    expect(screen.getByTestId('agent-approval-inline')).toHaveTextContent(
      'agentApproval.summary.connectedTool'
    )
    expect(screen.queryByText(approvalEvent.tool)).toBeNull()
    expect(screen.queryByText(approvalEvent.reason)).toBeNull()
    expect(screen.getByText('agentApproval.alwaysAllow')).toBeInTheDocument()

    fireEvent.click(screen.getByText('agentApproval.showDetails'))
    expect(screen.getByText(approvalEvent.tool)).toBeVisible()
    expect(screen.getByText(approvalEvent.reason)).toBeVisible()

    fireEvent.click(screen.getByText('agentApproval.approveOnce'))

    await waitFor(() =>
      expect(resolveAgentApproval).toHaveBeenCalledWith({
        approval_id: 'approval-1',
        decision: 'allow_once',
      })
    )
    await waitFor(() =>
      expect(
        useAgentRun.getState().getRun(THREAD).pendingApproval
      ).toBeUndefined()
    )
  })

  it('hides Always allow when the request cannot be remembered', () => {
    act(() => {
      useAgentRun.getState().startRun(THREAD, 'run-1')
      useAgentRun
        .getState()
        .applyEvent(THREAD, { ...approvalEvent, can_remember: false })
    })
    render(<AgentApprovalInline threadId={THREAD} />)

    expect(
      screen.queryByText('agentApproval.alwaysAllow')
    ).not.toBeInTheDocument()
  })

  it('expands the details disclosure', () => {
    act(() => {
      useAgentRun.getState().startRun(THREAD, 'run-1')
      useAgentRun.getState().applyEvent(THREAD, approvalEvent)
    })
    render(<AgentApprovalInline threadId={THREAD} />)

    expect(screen.queryByText(/bug/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('agentApproval.showDetails'))
    expect(screen.getByText(/bug/)).toBeInTheDocument()
    expect(screen.getByText('agentApproval.timeoutNotice')).toBeInTheDocument()
  })

  it('renders the folder-access variant and resolves an allow', async () => {
    resolveAgentFolderAccess.mockResolvedValue(undefined)
    resolveAgentWorkspaceRoot.mockResolvedValue({
      rootId: 'root-1',
      path: '/Users/me/project',
      name: 'project',
    })
    act(openFolderAccess)
    render(<AgentApprovalInline threadId={THREAD} />)

    expect(screen.getByText('agentFolderAccess.title')).toBeInTheDocument()
    expect(screen.getByText('/Users/me/project')).toBeInTheDocument()
    expect(screen.queryByText(/os\.fs\.read/)).toBeNull()
    expect(screen.getByText('agentFolderAccess.alwaysAllow')).toBeVisible()

    fireEvent.click(screen.getByText('agentFolderAccess.allow'))

    await waitFor(() =>
      expect(resolveAgentFolderAccess).toHaveBeenCalledWith({
        run_id: 'run-1',
        access_id: 'access-1',
        allow: true,
      })
    )
    expect(resolveAgentWorkspaceRoot).not.toHaveBeenCalled()
    expect(useAgentMode.getState().getWorkspace(THREAD).externalRoots).toEqual(
      []
    )
  })

  it('persists the folder only when Always Allow is chosen', async () => {
    resolveAgentFolderAccess.mockResolvedValue(undefined)
    resolveAgentWorkspaceRoot.mockResolvedValue({
      rootId: 'root-1',
      path: '/Users/me/project',
      name: 'project',
    })
    act(openFolderAccess)
    render(<AgentApprovalInline threadId={THREAD} />)

    fireEvent.click(screen.getByText('agentFolderAccess.alwaysAllow'))

    await waitFor(() =>
      expect(resolveAgentFolderAccess).toHaveBeenCalledWith({
        run_id: 'run-1',
        access_id: 'access-1',
        allow: true,
      })
    )
    expect(resolveAgentWorkspaceRoot).toHaveBeenCalledWith('/Users/me/project')
    expect(useAgentMode.getState().getWorkspace(THREAD).externalRoots).toEqual([
      {
        rootId: 'root-1',
        path: '/Users/me/project',
        name: 'project',
        canEdit: true,
      },
    ])
  })
})
