import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

/**
 * A value still on its way: a bar where the number will be, so nothing jumps when it lands.
 * A span, as it also sits inside the row's button.
 */
export function PendingValue({ className }: { className?: string }) {
  const { t } = useTranslation()
  return (
    <span
      role="status"
      aria-label={t('hub:table.loading')}
      data-slot="skeleton"
      className={cn(
        'inline-block h-3 w-10 animate-pulse rounded-md bg-accent align-middle',
        className
      )}
    />
  )
}
