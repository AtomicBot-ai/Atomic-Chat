import { useRef } from 'react'
import { toast } from 'sonner'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useAgentRun } from '@/hooks/useAgentRun'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  isStaleAgentApprovalError,
  isStaleAgentFolderAccessError,
  resolveAgentApproval,
  resolveAgentFolderAccess,
  resolveAgentWorkspaceRoot,
} from '@/services/agent/tauri'
import type { AgentApprovalResolution } from '@/types/agent'

/**
 * Thread-scoped resolve actions for pending agent approvals and folder-access
 * requests. Shared by the inline composer block and the global fallback
 * dialogs; keeps the double-resolve guard, the benign stale-race handling,
 * and the allow-folder side effect in one place.
 */
export function useAgentApprovalActions(threadId: string | undefined) {
  const { t } = useTranslation('chat')
  const resolvingApprovalIdRef = useRef<string | undefined>(undefined)
  const resolvingFolderIdRef = useRef<string | undefined>(undefined)
  const run = useAgentRun((state) =>
    threadId ? state.runs[threadId] : undefined
  )
  const approval = run?.pendingApproval
  const folderAccess = run?.pendingFolderAccess

  const resolveApproval = async (decision: AgentApprovalResolution) => {
    if (!threadId || !run || !approval) return
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

  const resolveFolderAccess = async (allow: boolean) => {
    if (!threadId || !run || !folderAccess) return
    if (
      run.folderAccessResolving ||
      resolvingFolderIdRef.current === folderAccess.access_id
    ) {
      return
    }
    resolvingFolderIdRef.current = folderAccess.access_id
    useAgentRun.getState().setFolderAccessResolving(threadId, true)
    try {
      if (allow) {
        const root = await resolveAgentWorkspaceRoot(folderAccess.path)
        useAgentMode.getState().addExternalRoot(threadId, {
          ...root,
          canEdit: true,
        })
      }
      await resolveAgentFolderAccess({
        run_id: folderAccess.run_id,
        access_id: folderAccess.access_id,
        allow,
      })
      useAgentRun
        .getState()
        .clearPendingFolderAccess(threadId, folderAccess.access_id)
    } catch (error) {
      if (isStaleAgentFolderAccessError(error)) {
        useAgentRun
          .getState()
          .clearPendingFolderAccess(threadId, folderAccess.access_id)
        return
      }
      resolvingFolderIdRef.current = undefined
      useAgentRun.getState().setFolderAccessResolving(threadId, false)
      toast.error(t('agentFolderAccess.resolveFailed'))
    }
  }

  return {
    run,
    approval,
    folderAccess,
    approvalResolving: Boolean(run?.approvalResolving),
    folderAccessResolving: Boolean(run?.folderAccessResolving),
    resolveApproval,
    resolveFolderAccess,
  }
}
