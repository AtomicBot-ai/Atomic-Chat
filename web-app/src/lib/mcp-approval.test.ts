import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useChatExecStatus } from '@/hooks/useChatExecStatus'
import { useToolApproval } from '@/hooks/useToolApproval'
import { act, renderHook } from '@testing-library/react'
import {
  approveChatToolCall,
  resolveExecAutoApprove,
  resolveMcpAutoApprove,
  useGlobalAutoApproveOverridesSelect,
} from '@/lib/mcp-approval'

const platformFeatures = vi.hoisted(() => ({}) as Record<string, boolean>)
vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  Object.assign(platformFeatures, actual.PlatformFeatures, { chatExec: true })
  return { ...actual, PlatformFeatures: platformFeatures }
})

describe('resolveMcpAutoApprove', () => {
  beforeEach(() => {
    useAgentMode.setState({ approvalModes: {} })
    useToolApproval.setState({ allowAllMCPPermissions: true })
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

describe('useGlobalAutoApproveOverridesSelect', () => {
  beforeEach(() => {
    useAgentMode.setState({ approvalModes: {} })
    useToolApproval.setState({ allowAllMCPPermissions: true })
  })

  it('flags a Restricted composer whose connector tools the global switch runs unasked', () => {
    const { result } = renderHook(() =>
      useGlobalAutoApproveOverridesSelect('t1')
    )

    expect(result.current).toBe(true)
    // What the flag discloses is what happens: the select reads Restricted,
    // yet an MCP call (web search) is auto-approved.
    expect(useAgentMode.getState().getApprovalMode('t1')).toBe('manual')
    expect(resolveMcpAutoApprove('t1')).toBe(true)
  })

  it('drops the flag once the switch is off or a mode is picked', () => {
    const { result } = renderHook(() =>
      useGlobalAutoApproveOverridesSelect('t1')
    )

    act(() => useToolApproval.setState({ allowAllMCPPermissions: false }))
    expect(result.current).toBe(false)

    act(() => {
      useToolApproval.setState({ allowAllMCPPermissions: true })
      useAgentMode.setState({ approvalModes: { t1: 'manual' } })
    })
    // An explicit Restricted asks, so there is nothing to disclose.
    expect(result.current).toBe(false)
    expect(resolveMcpAutoApprove('t1')).toBe(false)

    act(() => useAgentMode.setState({ approvalModes: { t1: 'skip' } }))
    expect(result.current).toBe(false)
  })
})

describe('approveChatToolCall', () => {
  const showApprovalModal = vi.fn()

  beforeEach(() => {
    showApprovalModal.mockReset().mockResolvedValue(true)
    useAgentMode.setState({ approvalModes: {} })
    useToolApproval.setState({
      allowAllMCPPermissions: true,
      showApprovalModal,
    })
    useChatExecStatus.setState({
      status: {
        supported: true,
        os: 'macos',
        shell: 'sh',
        languages: ['python'],
        sandbox: { kind: 'none', reason: null },
        userFolders: [],
      },
    })
  })

  afterEach(() => {
    useChatExecStatus.setState({ status: null })
  })

  it('asks before a command even while every MCP tool is auto-approved', async () => {
    await approveChatToolCall('run_command', 't1', { command: 'ls' })

    expect(resolveExecAutoApprove('t1')).toBe(false)
    expect(showApprovalModal).toHaveBeenCalledWith(
      'run_command',
      't1',
      { command: 'ls' },
      { bypassGlobalAutoApprove: true }
    )
  })

  it('runs commands without asking only on Full access', async () => {
    useAgentMode.setState({ approvalModes: { t1: 'skip' } })

    await expect(
      approveChatToolCall('run_script', 't1', { code: 'print(1)' })
    ).resolves.toBe(true)
    expect(showApprovalModal).not.toHaveBeenCalled()
  })

  it('keeps the MCP rule for every other tool', async () => {
    await expect(approveChatToolCall('search', 't1', {})).resolves.toBe(true)
    expect(showApprovalModal).not.toHaveBeenCalled()
  })

  it('treats a same-named MCP tool as MCP while chat offers no commands', async () => {
    useChatExecStatus.setState({ status: null })

    await expect(approveChatToolCall('run_command', 't1', {})).resolves.toBe(
      true
    )
    expect(showApprovalModal).not.toHaveBeenCalled()
  })
})
