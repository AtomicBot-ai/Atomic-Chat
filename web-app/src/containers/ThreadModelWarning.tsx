import { useTranslation } from '@/i18n/react-i18next-compat'

export function ThreadModelWarning({ modelId }: { modelId: string }) {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      className="mb-2 min-w-0 rounded-lg border border-border bg-secondary p-3 text-sm"
    >
      <p className="break-all font-medium">
        {t('chat:savedModelUnavailable', { model: modelId })}
      </p>
      <p className="text-muted-foreground">
        {t('chat:savedModelUnavailableHint')}
      </p>
    </div>
  )
}
