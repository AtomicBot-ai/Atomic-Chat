import { useId } from 'react'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'

type Props = {
  includeDate: boolean
  includeTime: boolean
  onDateChange: (enabled: boolean) => void
  onTimeChange: (enabled: boolean) => void
  disabled?: boolean
}

export function AssistantMessageClockSettings({
  includeDate,
  includeTime,
  onDateChange,
  onTimeChange,
  disabled,
}: Props) {
  const id = useId()
  const { t } = useTranslation()
  return (
    <div className="space-y-2">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <label htmlFor={`${id}-date`} className="min-w-0 text-sm">
          {t('assistants:includeDate')}
        </label>
        <Switch
          id={`${id}-date`}
          checked={includeDate}
          onCheckedChange={onDateChange}
          disabled={disabled}
        />
      </div>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <label htmlFor={`${id}-time`} className="min-w-0 text-sm">
          {t('assistants:includeTime')}
        </label>
        <Switch
          id={`${id}-time`}
          checked={includeTime}
          onCheckedChange={onTimeChange}
          disabled={disabled}
        />
      </div>
      <p className="text-xs leading-normal text-muted-foreground">
        {t('assistants:messageClockHint')}
      </p>
    </div>
  )
}
