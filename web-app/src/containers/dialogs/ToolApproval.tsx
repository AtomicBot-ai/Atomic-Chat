import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToolApproval } from '@/hooks/useToolApproval'
import { useChatExecStatus } from '@/hooks/useChatExecStatus'
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  chatExecLanguageName,
  DEFAULT_TIMEOUT_SECONDS,
  isChatExecTool,
  MAX_TIMEOUT_SECONDS,
  RUN_COMMAND_TOOL,
} from '@/lib/chat-exec-tools'
import type { ChatExecStatus } from '@/services/chat-exec/types'

type ExecCall = {
  title: string
  source: string
  timeoutSeconds: number
}

/** A `run_command` / `run_script` call as the user should read it. */
function describeExecCall(
  toolName: string,
  parameters: object | undefined,
  t: (key: string, options?: Record<string, unknown>) => string
): ExecCall | null {
  if (!isChatExecTool(toolName)) return null
  const args = (parameters ?? {}) as Record<string, unknown>
  const source =
    toolName === RUN_COMMAND_TOOL ? args.command : (args.code as unknown)
  const timeout = args.timeout_seconds
  return {
    title:
      toolName === RUN_COMMAND_TOOL
        ? t('tools:toolApproval.exec.commandTitle')
        : t('tools:toolApproval.exec.scriptTitle', {
            language: chatExecLanguageName(args.language) ?? args.language,
          }),
    source: typeof source === 'string' ? source : '',
    timeoutSeconds:
      typeof timeout === 'number' && timeout > 0
        ? Math.min(Math.round(timeout), MAX_TIMEOUT_SECONDS)
        : DEFAULT_TIMEOUT_SECONDS,
  }
}

function sandboxNotice(
  status: ChatExecStatus | null,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (status?.sandbox.kind === 'mxc')
    return t('tools:toolApproval.exec.sandboxed')
  if (status?.os === 'windows' && status.sandbox.reason) {
    return t('tools:toolApproval.exec.unsandboxedWindows', {
      reason: status.sandbox.reason,
    })
  }
  return t('tools:toolApproval.exec.unsandboxed')
}

export default function ToolApproval() {
  const { t } = useTranslation()
  const { isModalOpen, modalProps, setModalOpen } = useToolApproval()
  const execStatus = useChatExecStatus((state) => state.status)

  if (!modalProps) {
    return null
  }

  const { toolName, toolParameters, onApprove, onDeny } = modalProps
  const exec = describeExecCall(toolName, toolParameters, t)

  const handleAllowOnce = () => {
    onApprove(true) // true = allow once only
  }

  const handleAllow = () => {
    onApprove(false) // false = remember for this thread
  }

  const handleDeny = () => {
    onDeny()
  }

  const handleDialogOpen = (open: boolean) => {
    setModalOpen(open)
    if (!open) {
      onDeny()
    }
  }

  return (
    <Dialog open={isModalOpen} onOpenChange={handleDialogOpen}>
      <DialogContent
        className="sm:max-w-lg lg:max-w-lg xl:max-w-lg"
        showCloseButton={false}
      >
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="shrink-0 text-muted-foreground">
              <AlertTriangle className="size-4" />
            </div>
            <div>
              <DialogTitle>
                {exec ? exec.title : t('tools:toolApproval.title')}
              </DialogTitle>
              <DialogDescription className="mt-1 text-muted-foreground">
                {exec ? (
                  t('tools:toolApproval.exec.description')
                ) : (
                  <>
                    {t('tools:toolApproval.description')}{' '}
                    <span className="font-semibold">{toolName}</span>.&nbsp;
                    <span className="text-sm">
                      {t('tools:toolApproval.permissionScope')}
                    </span>
                  </>
                )}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {exec && (
          <pre
            data-testid="exec-approval-source"
            className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-secondary p-2 font-mono text-sm"
          >
            {exec.source}
          </pre>
        )}

        {!exec && toolParameters && Object.keys(toolParameters).length > 0 && (
          <div className="bg-background p-2 border rounded-lg overflow-x-scroll">
            <h4 className="text-sm font-medium mb-2">
              {t('tools:toolApproval.parameters')}
            </h4>
            <div className="relative bg-secondary rounded-md p-2 text-sm font-mono border overflow-x-auto">
              <pre className="whitespace-pre-wrap">
                {JSON.stringify(toolParameters, null, 2)}
              </pre>
            </div>
          </div>
        )}

        <div className="p-2 border bg-secondary rounded-lg">
          <p className="text-xs text-muted-foreground leading-relaxed">
            {exec
              ? `${sandboxNotice(execStatus, t)} ${t('tools:toolApproval.exec.timeout', { seconds: exec.timeoutSeconds })}`
              : t('tools:toolApproval.securityNotice')}
          </p>
        </div>

        <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDeny}
            className="flex-1 text-right sm:flex-none"
          >
            {t('tools:toolApproval.deny')}
          </Button>
          <div className="flex flex-col sm:flex-row gap-2 items-center">
            <Button variant="ghost" size="sm" onClick={handleAllowOnce}>
              {t('tools:toolApproval.allowOnce')}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleAllow}
              autoFocus
              className="capitalize"
            >
              {t('tools:toolApproval.alwaysAllow')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
