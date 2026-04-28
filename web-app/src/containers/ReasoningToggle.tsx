import { memo } from 'react'
import { IconBulb, IconBulbOff } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

type ReasoningToggleProps = {
  className?: string
}

const ReasoningToggle = memo(function ReasoningToggle({
  className,
}: ReasoningToggleProps) {
  const { t } = useTranslation()

  const disableReasoning = useGeneralSetting((state) => state.disableReasoning)
  const setDisableReasoning = useGeneralSetting(
    (state) => state.setDisableReasoning
  )

  const enabled = !disableReasoning
  const label = enabled
    ? t('common:reasoningToggleEnabled')
    : t('common:reasoningToggleDisabled')

  const handleClick = () => {
    setDisableReasoning(!disableReasoning)
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
              <IconBulb size={18} className="text-muted-foreground" />
            ) : (
              <IconBulbOff size={18} className="text-muted-foreground" />
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

export default ReasoningToggle
