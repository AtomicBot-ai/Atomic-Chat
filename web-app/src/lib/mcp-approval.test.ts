import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useToolApproval } from '@/hooks/useToolApproval'
import { approveChatToolCall, resolveMcpAutoApprove } from '@/lib/mcp-approval'

describe('resolveMcpAutoApprove', () => {
  beforeEach(() => {
    useAgentMode.setState({ approvalModes: {} })
    useToolApproval.setState({ allowAllMCPPermissions: true })
  })

  it('asks by default: a fresh store does not auto-approve MCP tools', () => {
    useToolApproval.setState(useToolApproval.getInitialState())

    expect(resolveMcpAutoApprove('t1')).toBe(false)
  })

  it('follows the global switch while the thread has no explicit mode', () => {
    expect(resolveMcpAutoApprove('t1')).toBe(true)

    useToolApproval.setState({ allowAllMCPPermissions: false })
    expect(resolveMcpAutoApprove('t1')).toBe(false)
  })

  it('lets an explicit skip auto-approve even with the global switch off', () => {
    useToolApproval.setState({ allowAllMCPPermissions: false })
    useAgentMode.setState({ approvalModes: { t1: 'skip' } })

    expect(resolveMcpAutoApprove('t1')).toBe(true)
  })

  it('lets an explicit manual prompt even with the global switch on', () => {
    useAgentMode.setState({ approvalModes: { t1: 'manual' } })

    expect(resolveMcpAutoApprove('t1')).toBe(false)
    // Other threads are untouched by t1's choice.
    expect(resolveMcpAutoApprove('t2')).toBe(true)
  })
})

describe('approveChatToolCall (regular chat path)', () => {
  beforeEach(() => {
    useAgentMode.setState({ approvalModes: {} })
    useToolApproval.setState({
      ...useToolApproval.getInitialState(),
      approvedTools: {},
    })
  })

  it('asks before an MCP tool call by default', async () => {
    const pending = approveChatToolCall('github_create_issue', 't1', {
      title: 'bug',
    })

    const modal = useToolApproval.getState()
    expect(modal.isModalOpen).toBe(true)
    expect(modal.modalProps?.toolName).toBe('github_create_issue')
    expect(modal.modalProps?.toolParameters).toEqual({ title: 'bug' })

    modal.modalProps?.onDeny()
    await expect(pending).resolves.toBe(false)
  })

  it('runs silently after "Always allow" for that tool on the thread', async () => {
    const first = approveChatToolCall('github_search', 't1')
    useToolApproval.getState().modalProps?.onApprove(false)
    await expect(first).resolves.toBe(true)

    await expect(approveChatToolCall('github_search', 't1')).resolves.toBe(true)
    expect(useToolApproval.getState().isModalOpen).toBe(false)

    // Another tool still asks.
    void approveChatToolCall('github_create_issue', 't1')
    expect(useToolApproval.getState().isModalOpen).toBe(true)
    useToolApproval.getState().modalProps?.onDeny()
  })

  it('runs silently only when the user opted in', async () => {
    useToolApproval.setState({ allowAllMCPPermissions: true })

    await expect(
      approveChatToolCall('github_create_issue', 't1')
    ).resolves.toBe(true)
    expect(useToolApproval.getState().isModalOpen).toBe(false)
  })

  it('still asks on a thread set to manual despite the opt-in', async () => {
    useToolApproval.setState({ allowAllMCPPermissions: true })
    useAgentMode.setState({ approvalModes: { t1: 'manual' } })

    const pending = approveChatToolCall('github_create_issue', 't1')
    expect(useToolApproval.getState().isModalOpen).toBe(true)
    useToolApproval.getState().modalProps?.onDeny()
    await expect(pending).resolves.toBe(false)
  })
})
