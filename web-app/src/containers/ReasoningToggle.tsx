import { memo } from 'react'
import * as SliderPrimitive from '@radix-ui/react-slider'
import { IconBulb, IconChevronDown } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  availableReasoningLevels,
  resolveReasoningLevel,
} from '@/lib/reasoning-effort'
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
  const reasoningBudget = useGeneralSetting((state) => state.reasoningBudget)
  const setReasoningBudget = useGeneralSetting(
    (state) => state.setReasoningBudget
  )
  const selectedModel = useModelProvider((state) => state.selectedModel)

  const enabled = !disableReasoning
  const label = enabled
    ? t('common:reasoningToggleEnabled')
    : t('common:reasoningToggleDisabled')

  const handleClick = () => {
    setDisableReasoning(!disableReasoning)
  }

  // The effort picker is a separate control that only appears once reasoning is
  // on and the model's chat template declares a thinking phase. Switching
  // reasoning on and off stays entirely on the bulb.
  const levels = availableReasoningLevels(selectedModel?.reasoning)
  const level =
    reasoningBudget === 'off'
      ? undefined
      : resolveReasoningLevel(reasoningBudget, levels)
  const levelLabel = level ? t(`common:reasoningEffort.${level}`) : undefined
  const isMax = level === 'max'

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                enabled &&
                  'bg-blue-500/10 text-blue-500 hover:bg-blue-500/15 hover:text-blue-500',
                className
              )}
              aria-label={label}
              aria-pressed={enabled}
              onClick={handleClick}
            >
              <IconBulb
                size={18}
                className={cn(
                  enabled ? 'text-blue-500' : 'text-muted-foreground'
                )}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{label}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {enabled && level && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 bg-blue-500/10 text-blue-500 hover:bg-blue-500/15 hover:text-blue-500"
              aria-label={t('common:reasoningEffort.ariaLabel', {
                level: levelLabel,
              })}
            >
              <span className="text-xs">{levelLabel}</span>
              <IconChevronDown size={14} className="text-blue-500" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="bottom"
            align="start"
            sideOffset={6}
            className="w-56 p-2.5"
          >
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">
                {t('common:reasoningEffort.title')}
              </span>
              <span className={cn('font-medium', isMax && 'text-blue-500')}>
                {levelLabel}
              </span>
            </div>
            {levels.length > 1 && (
              <>
                <div className="text-muted-foreground mt-2 flex items-center justify-between text-[11px]">
                  <span>{t('common:reasoningEffort.faster')}</span>
                  <span>{t('common:reasoningEffort.smarter')}</span>
                </div>
                <SliderPrimitive.Root
                  className="relative mt-1 flex h-6 w-full touch-none items-center select-none"
                  min={0}
                  max={levels.length - 1}
                  step={1}
                  value={[levels.indexOf(level)]}
                  onValueChange={([next]) => setReasoningBudget(levels[next])}
                >
                  <SliderPrimitive.Track className="bg-muted relative h-6 w-full grow rounded-full">
                    {isMax ? (
                      <div className="absolute inset-0 rounded-full bg-linear-to-r from-blue-500/10 via-blue-500/55 to-blue-500" />
                    ) : (
                      <SliderPrimitive.Range className="bg-muted-foreground/10 absolute h-full rounded-full" />
                    )}
                    {/* Stops line up with where the thumb can actually sit:
                        inset by half the thumb (12px) minus half a dot (2px). */}
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-[10px]">
                      {levels.map((option, index) => (
                        <span
                          key={option}
                          className={cn(
                            'size-1 rounded-full',
                            index === levels.length - 1
                              ? 'bg-blue-500'
                              : 'bg-muted-foreground/30'
                          )}
                        />
                      ))}
                    </div>
                  </SliderPrimitive.Track>
                  <SliderPrimitive.Thumb
                    aria-label={t('common:reasoningEffort.title')}
                    aria-valuetext={levelLabel}
                    className="bg-background ring-ring/50 block h-5 w-6 rounded-lg shadow-md outline-hidden focus-visible:ring-4"
                  />
                </SliderPrimitive.Root>
              </>
            )}
          </PopoverContent>
        </Popover>
      )}
    </>
  )
})

export default ReasoningToggle
