import { IconAlertCircle } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'

export function AgentNoToolsWarning({
  allowFallback,
}: {
  allowFallback: boolean
}) {
  const { t } = useTranslation()
  const enabled = useGeneralSetting((state) => state.agentModeEnabled)
  const setEnabled = useGeneralSetting((state) => state.setAgentModeEnabled)

  return (
    <div
      role="status"
      className="not-prose mt-3 flex items-start gap-3 rounded-xl border border-border bg-secondary/50 p-3"
      data-testid="agent-no-tools-warning"
    >
      <IconAlertCircle
        size={18}
        className="mt-0.5 shrink-0 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {t('chat:agentMode.noToolsTitle')}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t('chat:agentMode.noToolsBody')}
        </p>
        {allowFallback && enabled && (
          <Button
            variant="outline"
            size="sm"
            className="mt-2 max-w-full whitespace-normal h-auto min-h-8"
            onClick={() => setEnabled(false)}
          >
            {t('chat:agentMode.noToolsFallback')}
          </Button>
        )}
      </div>
    </div>
  )
}
