import { describe, expect, it } from 'vitest'

import { agentApprovalSummary } from './agent-approval-copy'

const t = (key: string) => key

describe('agentApprovalSummary', () => {
  it.each([
    ['os.shell.run', 'agentApproval.summary.command'],
    ['os.proc.spawn', 'agentApproval.summary.command'],
    ['skill.run_script', 'agentApproval.summary.script'],
    ['os.fs.trash', 'agentApproval.summary.deleteFiles'],
    ['os.fs.write', 'agentApproval.summary.changeFiles'],
    ['os.web.request', 'agentApproval.summary.internet'],
    ['os.git.commit', 'agentApproval.summary.repository'],
    ['mcp.github.create_issue', 'agentApproval.summary.connectedTool'],
    ['vendor.unknown', 'agentApproval.summary.generic'],
  ])('maps %s to human copy', (tool, expected) => {
    expect(agentApprovalSummary({ tool }, t)).toBe(expected)
  })

  it('uses affected operations when a tool name is unknown', () => {
    expect(
      agentApprovalSummary(
        {
          tool: 'vendor.files',
          affected_resources: [
            { kind: 'file', value: '/tmp/a', operation: 'delete' },
          ],
        },
        t
      )
    ).toBe('agentApproval.summary.deleteFiles')
  })
})
