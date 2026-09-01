import { IconLoader2, IconRefresh, IconTrash } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

import { ApiSettingsPopover } from './ApiSettingsPopover'

export function ApiPageHeaderActions({
  isRunning,
  isBusy,
  isModelLoading,
  status,
  onToggleServer,
  onRefresh,
  onClear,
  refreshing,
}: {
  isRunning: boolean
  isBusy: boolean
  isModelLoading: boolean
  status: 'running' | 'stopped' | 'pending'
  onToggleServer: () => void
  onRefresh: () => void
  onClear: () => void
  refreshing: boolean
}) {
  const { t } = useTranslation()

  const serverButtonLabel = isModelLoading
    ? t('api:actions.loadingModel')
    : status === 'pending'
      ? t('api:actions.starting')
      : isRunning
        ? t('api:actions.stop')
        : t('api:actions.start')

  return (
    <div className="relative z-50 flex shrink-0 items-center gap-2">
      <Button variant="outline" size="sm" onClick={onRefresh}>
        <IconRefresh size={14} className={cn(refreshing && 'animate-spin')} />
        {t('api:actions.refresh')}
      </Button>

      <Button variant="outline" size="sm" onClick={onClear}>
        <IconTrash size={14} />
        {t('api:actions.clearLog')}
      </Button>

      <ApiSettingsPopover isServerRunning={isRunning} />

      <Button
        size="sm"
        variant={isRunning ? 'destructive' : 'default'}
        onClick={onToggleServer}
        disabled={isBusy}
      >
        {isBusy && <IconLoader2 size={14} className="animate-spin" />}
        {serverButtonLabel}
      </Button>
    </div>
  )
}
