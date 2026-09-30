import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAgentRun } from '@/hooks/useAgentRun'
import { useThreads } from '@/hooks/useThreads'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  isStaleAgentApprovalError,
  resolveAgentApproval,
} from '@/services/agent/tauri'
import type { AgentApprovalResolution } from '@/types/agent'
import { agentApprovalSummary } from '@/lib/agent-approval-copy'

const PREVIEW_LIMIT = 4_000
const RESOURCE_VALUE_LIMIT = 512

function boundedJson(value: unknown): string {
  let serialized: string
  try {
    serialized = JSON.stringify(value, null, 2)
  } catch {
    serialized = String(value)
  }
  return serialized.length > PREVIEW_LIMIT
    ? `${serialized.slice(0, PREVIEW_LIMIT)}\n…`
    : serialized
}

export default function AgentApprovalDialog() {
  const { t } = useTranslation('chat')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const resolvingApprovalIdRef = useRef<string | undefined>(undefined)
  const threadId = useAgentRun((state) =>
    Object.keys(state.runs).find(
      (candidate) => state.runs[candidate].pendingApproval !== undefined
    )
  )
  const run = useAgentRun((state) =>
    threadId ? state.runs[threadId] : undefined
  )
  const approval = run?.pendingApproval
  const currentThreadId = useThreads((state) => state.currentThreadId)
  const preview = useMemo(
    () => (approval ? boundedJson(approval.preview) : ''),
    [approval]
  )
  const approvalCopy = useMemo(
    () => (approval ? agentApprovalSummary(approval, t) : ''),
    [approval, t]
  )

  if (!threadId || !run || !approval) {
    return null
  }
  // The open thread renders its approvals inline in the composer; the modal
  // remains the safety net for a run awaiting approval on another screen.
  if (threadId === currentThreadId) {
    return null
  }

  const resolve = async (decision: AgentApprovalResolution) => {
    if (
      run.approvalResolving ||
      resolvingApprovalIdRef.current === approval.approval_id
    ) {
      return
    }
    resolvingApprovalIdRef.current = approval.approval_id
    useAgentRun.getState().setApprovalResolving(threadId, true)
    try {
      await resolveAgentApproval({
        approval_id: approval.approval_id,
        decision,
      })
      useAgentRun
        .getState()
        .clearPendingApproval(threadId, approval.approval_id)
    } catch (error) {
      if (isStaleAgentApprovalError(error)) {
        useAgentRun
          .getState()
          .clearPendingApproval(threadId, approval.approval_id)
        return
      }
      resolvingApprovalIdRef.current = undefined
      useAgentRun.getState().setApprovalResolving(threadId, false)
      toast.error(t('agentApproval.resolveFailed'))
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void resolve('deny')
      }}
    >
      <DialogContent
        className="sm:max-w-lg lg:max-w-lg xl:max-w-lg"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{t('agentApproval.title')}</DialogTitle>
          <DialogDescription>{approvalCopy}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <button
            type="button"
            className="cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {detailsOpen
              ? t('agentApproval.hideDetails')
              : t('agentApproval.showDetails')}
          </button>

          {detailsOpen && (
            <div className="space-y-3">
              <div className="rounded-md border bg-secondary px-2 py-1.5 text-xs">
                <div>
                  <span className="font-medium">
                    {t('agentApproval.tool')}:
                  </span>{' '}
                  <code>{approval.tool}</code>
                </div>
                <div className="mt-1 text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {t('agentApproval.reason')}:
                  </span>{' '}
                  {approval.reason}
                </div>
              </div>

              {preview && (
                <div>
                  <div className="mb-1 text-xs font-medium">
                    {t('agentApproval.preview')}
                  </div>
                  <pre className="max-h-48 overflow-auto rounded-md border bg-secondary p-2 text-xs whitespace-pre-wrap break-all">
                    {preview}
                  </pre>
                </div>
              )}

              {approval.affected_resources.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-medium">
                    {t('agentApproval.resources')}
                  </div>
                  <div className="space-y-1">
                    {approval.affected_resources.map((resource, index) => (
                      <div
                        key={`${resource.kind}-${resource.operation}-${index}`}
                        className="rounded-md border px-2 py-1.5 text-xs"
                      >
                        <span className="font-medium">
                          {resource.operation}
                        </span>{' '}
                        <span className="text-muted-foreground">
                          {resource.kind}:{' '}
                          {resource.value.slice(0, RESOURCE_VALUE_LIMIT)}
                          {resource.value.length > RESOURCE_VALUE_LIMIT
                            ? '…'
                            : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {t('agentApproval.timeoutNotice')}
          </p>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            disabled={run.approvalResolving}
            onClick={() => void resolve('deny')}
          >
            {t('agentApproval.deny')}
          </Button>
          {approval.can_remember && (
            <Button
              variant="outline"
              size="sm"
              disabled={run.approvalResolving}
              onClick={() => void resolve('always_allow')}
            >
              {t('agentApproval.alwaysAllow')}
            </Button>
          )}
          <Button
            size="sm"
            disabled={run.approvalResolving}
            onClick={() => void resolve('allow_once')}
            autoFocus
          >
            {t('agentApproval.approveOnce')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
