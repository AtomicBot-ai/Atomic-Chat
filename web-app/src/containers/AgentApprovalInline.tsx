import { useEffect, useMemo, useState } from 'react'
import { IconShieldQuestion, IconFolderQuestion } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { useAgentApprovalActions } from '@/hooks/useAgentApprovalActions'
import { useTranslation } from '@/i18n/react-i18next-compat'

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

type AgentApprovalInlineProps = {
  threadId: string
}

/**
 * The approval surface for the open thread: a card docked to the top of the
 * composer, replacing the modal for the conversation the user is looking at.
 * A run awaiting approval reports `submitted` status, which disables the
 * toolbar's left cluster — this card lives outside that cluster on purpose.
 */
export default function AgentApprovalInline({
  threadId,
}: AgentApprovalInlineProps) {
  const { t } = useTranslation('chat')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const {
    approval,
    folderAccess,
    approvalResolving,
    folderAccessResolving,
    resolveApproval,
    resolveFolderAccess,
  } = useAgentApprovalActions(threadId)
  const preview = useMemo(
    () => (approval ? boundedJson(approval.preview) : ''),
    [approval]
  )

  // Keyboard affordance while the card is up, wherever focus sits (usually
  // the composer textarea): Mod+Enter approves. Deliberately no Escape
  // binding — Escape routinely dismisses unrelated overlays (menus, previews)
  // and must never double as an unintended deny; denying is a click.
  const hasApproval = Boolean(approval)
  const hasFolderAccess = Boolean(folderAccess)
  useEffect(() => {
    if (!hasApproval && !hasFolderAccess) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        if (hasApproval) void resolveApproval('allow_once')
        else void resolveFolderAccess(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // Re-bind per request id so the closure never resolves a superseded one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hasApproval,
    hasFolderAccess,
    approval?.approval_id,
    folderAccess?.access_id,
  ])

  if (!approval && !folderAccess) return null

  return (
    <div
      role="group"
      aria-live="polite"
      className="relative z-10 -mb-3 rounded-t-2xl border border-b-0 border-input bg-secondary/60 px-4 pt-3 pb-6 backdrop-blur-sm"
      data-testid="agent-approval-inline"
    >
      {approval ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <IconShieldQuestion
              size={16}
              className="mt-0.5 shrink-0 text-amber-500"
            />
            <div className="min-w-0 flex-1 text-sm">
              <span className="font-medium">{t('agentApproval.title')}</span>
              <span className="text-muted-foreground">
                {' '}
                · <code className="text-xs">{approval.tool}</code> —{' '}
                {approval.reason}
              </span>
            </div>
          </div>
          <div>
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
              <div className="mt-2 space-y-2">
                {preview && (
                  <pre className="max-h-40 overflow-auto rounded-md border bg-secondary p-2 text-xs whitespace-pre-wrap break-all">
                    {preview}
                  </pre>
                )}
                {approval.affected_resources.length > 0 && (
                  <div className="space-y-1">
                    {approval.affected_resources.map((resource, index) => (
                      <div
                        key={`${resource.kind}-${resource.operation}-${index}`}
                        className="rounded-md border px-2 py-1 text-xs"
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
                )}
                <p className="text-xs text-muted-foreground">
                  {t('agentApproval.timeoutNotice')}
                </p>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={approvalResolving}
              onClick={() => void resolveApproval('allow_once')}
              autoFocus
            >
              {t('agentApproval.approveOnce')}
            </Button>
            {approval.can_remember && (
              <Button
                variant="outline"
                size="sm"
                disabled={approvalResolving}
                onClick={() => void resolveApproval('always_allow')}
              >
                {t('agentApproval.alwaysAllow')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={approvalResolving}
              onClick={() => void resolveApproval('deny')}
            >
              {t('agentApproval.deny')}
            </Button>
          </div>
        </div>
      ) : folderAccess ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <IconFolderQuestion
              size={16}
              className="mt-0.5 shrink-0 text-amber-500"
            />
            <div className="min-w-0 flex-1 text-sm">
              <span className="font-medium">
                {t('agentFolderAccess.title')}
              </span>
              <span className="text-muted-foreground">
                {' '}
                · {t('agentFolderAccess.description', {
                  tool: folderAccess.tool,
                })}
              </span>
            </div>
          </div>
          <div className="rounded-md border bg-secondary px-2 py-1.5 text-xs break-all">
            {folderAccess.path}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('agentFolderAccess.canEditNotice')}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={folderAccessResolving}
              onClick={() => void resolveFolderAccess(true)}
              autoFocus
            >
              {t('agentFolderAccess.allow')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={folderAccessResolving}
              onClick={() => void resolveFolderAccess(false)}
            >
              {t('agentFolderAccess.deny')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
