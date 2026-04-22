import { memo } from 'react'
import { IconBell, IconBellOff } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useThreadNotifications } from '@/hooks/useThreadNotifications'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

type ThreadNotificationToggleProps = {
  // When `threadId` is omitted, the toggle flips the "pending default" flag
  // that will be applied to the next thread created from the New Chat screen.
  threadId?: string
  className?: string
}

const ThreadNotificationToggle = memo(function ThreadNotificationToggle({
  threadId,
  className,
}: ThreadNotificationToggleProps) {
  const { t } = useTranslation()

  const threadEnabled = useThreadNotifications((state) =>
    threadId ? state.enabledThreads[threadId] === true : false
  )
  const pendingEnabled = useThreadNotifications((state) => state.pendingDefault)
  const toggleThread = useThreadNotifications((state) => state.toggle)
  const togglePendingDefault = useThreadNotifications(
    (state) => state.togglePendingDefault
  )

  const enabled = threadId ? threadEnabled : pendingEnabled

  const label = t('settings:threadNotifications.tooltip')

  const handleClick = () => {
    if (threadId) {
      toggleThread(threadId)
    } else {
      togglePendingDefault()
    }
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(className)}
            aria-label={label}
            aria-pressed={enabled}
            onClick={handleClick}
          >
            {enabled ? (
              <IconBell size={18} className="text-primary" />
            ) : (
              <IconBellOff size={18} className="text-muted-foreground" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
})

export default ThreadNotificationToggle
