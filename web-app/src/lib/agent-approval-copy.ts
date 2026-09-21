import type { AgentApprovalResource } from '@/types/agent'

type Translate = (key: string, values?: Record<string, unknown>) => string

type ApprovalCopyInput = {
  tool: string
  affected_resources?: AgentApprovalResource[]
}

/**
 * Human consequence shown on the approval surface. Raw tool identifiers and
 * backend policy reasons belong in Show details, not in the decision headline.
 */
export function agentApprovalSummary(
  approval: ApprovalCopyInput,
  t: Translate
): string {
  const tool = approval.tool.toLowerCase()
  const operations = new Set(
    (approval.affected_resources ?? []).map((item) =>
      item.operation.toLowerCase()
    )
  )

  if (/^os\.(shell|proc)\./.test(tool)) {
    return t('agentApproval.summary.command')
  }
  if (tool.startsWith('skill.run_script')) {
    return t('agentApproval.summary.script')
  }
  if (
    /^os\.fs\.(trash|delete|remove)/.test(tool) ||
    operations.has('delete') ||
    operations.has('remove')
  ) {
    return t('agentApproval.summary.deleteFiles')
  }
  if (
    tool.startsWith('os.fs.') ||
    [...operations].some((operation) =>
      ['write', 'create', 'move', 'copy', 'rename'].includes(operation)
    )
  ) {
    return t('agentApproval.summary.changeFiles')
  }
  if (/^os\.(web|http)\./.test(tool)) {
    return t('agentApproval.summary.internet')
  }
  if (tool.startsWith('os.git.')) {
    return t('agentApproval.summary.repository')
  }
  if (tool.startsWith('mcp.') || tool.startsWith('mcp__')) {
    return t('agentApproval.summary.connectedTool')
  }
  return t('agentApproval.summary.generic')
}
