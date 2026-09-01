import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useToolApproval } from '@/hooks/useToolApproval'
import { resolveMcpAutoApprove } from '@/lib/mcp-approval'

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
