import { useRef } from 'react'
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
import { useAgentMode } from '@/hooks/useAgentMode'
import { useAgentRun } from '@/hooks/useAgentRun'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  isStaleAgentFolderAccessError,
  resolveAgentFolderAccess,
  resolveAgentWorkspaceRoot,
} from '@/services/agent/tauri'

export default function AgentFolderAccessDialog() {
  const { t } = useTranslation('chat')
  const resolvingIdRef = useRef<string | undefined>(undefined)
  const threadId = useAgentRun((state) =>
    Object.keys(state.runs).find(
      (candidate) => state.runs[candidate].pendingFolderAccess !== undefined
    )
  )
  const run = useAgentRun((state) =>
    threadId ? state.runs[threadId] : undefined
  )
  const request = run?.pendingFolderAccess

  if (!threadId || !run || !request) return null

  const resolve = async (allow: boolean) => {
    if (
      run.folderAccessResolving ||
      resolvingIdRef.current === request.access_id
    ) {
      return
    }
    resolvingIdRef.current = request.access_id
    useAgentRun.getState().setFolderAccessResolving(threadId, true)
    try {
      if (allow) {
        const root = await resolveAgentWorkspaceRoot(request.path)
        useAgentMode.getState().addExternalRoot(threadId, {
          ...root,
          canEdit: true,
        })
      }
      await resolveAgentFolderAccess({
        run_id: request.run_id,
        access_id: request.access_id,
        allow,
      })
      useAgentRun
        .getState()
        .clearPendingFolderAccess(threadId, request.access_id)
    } catch (error) {
      if (isStaleAgentFolderAccessError(error)) {
        useAgentRun
          .getState()
          .clearPendingFolderAccess(threadId, request.access_id)
        return
      }
      resolvingIdRef.current = undefined
      useAgentRun.getState().setFolderAccessResolving(threadId, false)
      toast.error(t('agentFolderAccess.resolveFailed'))
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
          <DialogTitle>{t('agentFolderAccess.title')}</DialogTitle>
          <DialogDescription>
            {t('agentFolderAccess.description', { tool: request.tool })}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-secondary p-3 text-sm break-all">
          {request.path}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('agentFolderAccess.canEditNotice')}
        </p>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            disabled={run.folderAccessResolving}
            onClick={() => void resolve(false)}
          >
            {t('agentFolderAccess.deny')}
          </Button>
          <Button
            size="sm"
            disabled={run.folderAccessResolving}
            onClick={() => void resolve(true)}
            autoFocus
          >
            {t('agentFolderAccess.allow')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
