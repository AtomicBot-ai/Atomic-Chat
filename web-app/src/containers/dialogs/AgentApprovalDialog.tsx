import { useMemo, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'
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
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  isStaleAgentApprovalError,
  resolveAgentApproval,
} from '@/services/agent/tauri'

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
  const preview = useMemo(
    () => (approval ? boundedJson(approval.preview) : ''),
    [approval]
  )

  if (!threadId || !run || !approval) {
    return null
  }

  const resolve = async (approved: boolean) => {
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
        approved,
      })
      useAgentRun.getState().clearPendingApproval(threadId)
    } catch (error) {
      if (isStaleAgentApprovalError(error)) {
        useAgentRun.getState().clearPendingApproval(threadId)
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
        if (!open) void resolve(false)
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <div>
              <DialogTitle>{t('agentApproval.title')}</DialogTitle>
              <DialogDescription className="mt-1">
                {t('agentApproval.description', { tool: approval.tool })}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <div className="mb-1 text-xs font-medium">
              {t('agentApproval.reason')}
            </div>
            <p className="text-sm text-muted-foreground">{approval.reason}</p>
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
                    <span className="font-medium">{resource.operation}</span>{' '}
                    <span className="text-muted-foreground">
                      {resource.kind}:{' '}
                      {resource.value.slice(0, RESOURCE_VALUE_LIMIT)}
                      {resource.value.length > RESOURCE_VALUE_LIMIT ? '…' : ''}
                    </span>
                  </div>
                ))}
              </div>
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
            onClick={() => void resolve(false)}
          >
            {t('agentApproval.deny')}
          </Button>
          <Button
            size="sm"
            disabled={run.approvalResolving}
            onClick={() => void resolve(true)}
            autoFocus
          >
            {t('agentApproval.approveOnce')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
