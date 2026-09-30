import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAgentApprovalActions } from '@/hooks/useAgentApprovalActions'
import { useAgentRun } from '@/hooks/useAgentRun'
import { useThreads } from '@/hooks/useThreads'
import { useTranslation } from '@/i18n/react-i18next-compat'

export default function AgentFolderAccessDialog() {
  const { t } = useTranslation('chat')
  const threadId = useAgentRun((state) =>
    Object.keys(state.runs).find(
      (candidate) => state.runs[candidate].pendingFolderAccess !== undefined
    )
  )
  const {
    run,
    folderAccess: request,
    folderAccessResolving,
    resolveFolderAccess,
  } = useAgentApprovalActions(threadId)
  const currentThreadId = useThreads((state) => state.currentThreadId)

  if (!threadId || !run || !request) return null
  // The open thread renders folder-access requests inline in the composer.
  if (threadId === currentThreadId) return null

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void resolveFolderAccess('deny')
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
            size="sm"
            disabled={folderAccessResolving}
            onClick={() => void resolveFolderAccess('allow_once')}
            autoFocus
          >
            {t('agentFolderAccess.allow')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={folderAccessResolving}
            onClick={() => void resolveFolderAccess('always_allow')}
          >
            {t('agentFolderAccess.alwaysAllow')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={folderAccessResolving}
            onClick={() => void resolveFolderAccess('deny')}
          >
            {t('agentFolderAccess.deny')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
