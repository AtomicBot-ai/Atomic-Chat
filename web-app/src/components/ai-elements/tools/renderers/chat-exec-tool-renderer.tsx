import { useServiceStore } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ToolPresentation } from '@/lib/tools/types'

type ChatExecToolRendererProps = {
  presentation: Extract<ToolPresentation, { kind: 'chat_exec' }>
}

/** A command or script and what it printed, as the model saw it. */
export function ChatExecToolRenderer({
  presentation,
}: ChatExecToolRendererProps) {
  const { t } = useTranslation('chat')
  const serviceHub = useServiceStore((state) => state.serviceHub)
  const { source, output, errorText } = presentation

  return (
    <div className="space-y-2">
      {source && (
        <pre
          data-testid="chat-exec-source"
          className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-secondary p-2 font-mono text-xs"
        >
          {source}
        </pre>
      )}
      {output && (
        <pre
          data-testid="chat-exec-output"
          className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border p-2 font-mono text-xs"
        >
          {output.text}
        </pre>
      )}
      {errorText && (
        <p className="text-xs text-destructive whitespace-pre-wrap">
          {errorText}
        </p>
      )}
      {output && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {output.sandbox === 'mxc' && (
            <span>{t('toolCall.exec.sandboxed')}</span>
          )}
          {output.workdir && serviceHub && (
            <button
              type="button"
              className="underline-offset-2 hover:text-foreground hover:underline"
              onClick={() =>
                void serviceHub
                  .opener()
                  .openPath(output.workdir)
                  .catch((error) =>
                    console.error('Could not open the chat folder:', error)
                  )
              }
            >
              {t('toolCall.exec.openFolder')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
