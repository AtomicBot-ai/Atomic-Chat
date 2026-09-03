import { memo, useCallback, useEffect, useRef, useState } from 'react'
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
  DEFAULT_REASONING_LEVELS,
  availableReasoningLevels,
  resolveReasoningLevel,
} from '@/lib/reasoning-effort'
import { cn } from '@/lib/utils'

type ReasoningToggleProps = {
  className?: string
}

/**
 * Sub-steps the slider keeps between two levels. The value the user picks is
 * still one of the levels, but the thumb rides a fine scale so a drag tracks
 * the pointer instead of hopping stop to stop; on release it settles onto the
 * nearest level.
 */
const SUBSTEPS = 100

/**
 * Settle used everywhere the control moves on its own: quick off the mark,
 * long soft landing. Matches the feel of the reference effort picker.
 */
const GLIDE = 'duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'

const clampIndex = (value: number, last: number) =>
  Math.min(Math.max(value, 0), last)

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
  // No model picked yet — keep the full scale so the chosen level stays
  // visible; a *selected* model without a thinking phase still hides it.
  const levels = selectedModel
    ? availableReasoningLevels(selectedModel.reasoning)
    : DEFAULT_REASONING_LEVELS
  const level =
    reasoningBudget === 'off'
      ? undefined
      : resolveReasoningLevel(reasoningBudget, levels)
  const levelLabel = level ? t(`common:reasoningEffort.${level}`) : undefined
  const isMax = level === 'max'
  // With the picker visible the bulb and the effort button share one pill so
  // they read as a single control; alone, the bulb keeps its own background.
  const hasPicker = enabled && Boolean(level)

  const lastIndex = levels.length - 1
  const levelIndex = level ? levels.indexOf(level) : 0

  // Where the thumb actually sits, in sub-steps. Free-running under the
  // pointer, pinned to the level everywhere else. The ref shadows the state so
  // a pointer-up can read the position it was left at without a stale closure.
  const [dragging, setDragging] = useState(false)
  const [position, setPosition] = useState(levelIndex * SUBSTEPS)
  const positionRef = useRef(position)
  const moveTo = useCallback((next: number) => {
    positionRef.current = next
    setPosition(next)
  }, [])
  useEffect(() => {
    if (!dragging) moveTo(levelIndex * SUBSTEPS)
  }, [dragging, levelIndex, moveTo])

  // The trigger label is frozen while the picker is open: its width drives the
  // whole toolbar, so relabelling on every drag step makes the row twitch under
  // the cursor. The panel shows the live level, the trigger catches up on close.
  const [pickerOpen, setPickerOpen] = useState(false)
  const [settledLevel, setSettledLevel] = useState(level)
  useEffect(() => {
    if (!pickerOpen) {
      setSettledLevel(level)
      // A drag cut short by the panel closing never gets its pointer-up, and a
      // stuck `dragging` would leave the glide off for good.
      setDragging(false)
    }
  }, [pickerOpen, level])
  // The picker itself can go away under an open panel — reasoning switched off,
  // or a model with no thinking phase — and a still-open flag would spring the
  // panel back the next time it returns.
  useEffect(() => {
    if (!hasPicker) setPickerOpen(false)
  }, [hasPicker])
  const settledLabel = settledLevel
    ? t(`common:reasoningEffort.${settledLevel}`)
    : levelLabel

  // Radix only learns the thumb's width after its first paint, and then nudges
  // `left` by half of it. With the glide already live that correction plays as
  // a slide of up to half a thumb every time the panel opens, so it waits for
  // the layout to settle first.
  const [glide, setGlide] = useState(false)
  useEffect(() => {
    if (!pickerOpen) {
      setGlide(false)
      return
    }
    let settled = 0
    const painted = requestAnimationFrame(() => {
      settled = requestAnimationFrame(() => setGlide(true))
    })
    // A backgrounded window never paints, so the frames above never arrive;
    // the picker would then be left without its glide for good.
    const fallback = setTimeout(() => setGlide(true), 150)
    return () => {
      cancelAnimationFrame(painted)
      cancelAnimationFrame(settled)
      clearTimeout(fallback)
    }
  }, [pickerOpen])
  /** Motion the control makes on its own, as opposed to under the pointer. */
  const gliding = glide && !dragging

  const applyIndex = useCallback(
    (index: number) => {
      const next = levels[clampIndex(index, levels.length - 1)]
      if (next && next !== level) setReasoningBudget(next)
    },
    [levels, level, setReasoningBudget]
  )

  /** End of a pointer pass: back onto the nearest level, gliding as it goes. */
  const settle = useCallback(() => {
    setDragging(false)
    const index = clampIndex(
      Math.round(positionRef.current / SUBSTEPS),
      lastIndex
    )
    moveTo(index * SUBSTEPS)
    applyIndex(index)
  }, [applyIndex, lastIndex, moveTo])

  // Arrow/Home/End move a whole level: Radix would otherwise step by one
  // sub-step, which on this scale is an invisible nudge. Preventing the default
  // is what stops its own handler from running.
  const handleKeyDown = (event: React.KeyboardEvent) => {
    const target =
      event.key === 'Home' || event.key === 'PageDown'
        ? 0
        : event.key === 'End' || event.key === 'PageUp'
          ? lastIndex
          : event.key === 'ArrowRight' || event.key === 'ArrowUp'
            ? levelIndex + 1
            : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
              ? levelIndex - 1
              : undefined
    if (target === undefined) return

    event.preventDefault()
    const index = clampIndex(target, lastIndex)
    setDragging(false)
    moveTo(index * SUBSTEPS)
    applyIndex(index)
  }

  return (
    <div
      className={cn(
        'inline-flex items-center rounded-full',
        hasPicker && 'bg-blue-500/10',
        className
      )}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                enabled && 'text-blue-500 hover:text-blue-500',
                enabled && !hasPicker && 'bg-blue-500/10 hover:bg-blue-500/15',
                hasPicker && 'hover:bg-blue-500/10'
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
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 pl-1.5 pr-2 text-blue-500 hover:bg-blue-500/10 hover:text-blue-500"
              aria-label={t('common:reasoningEffort.ariaLabel', {
                level: settledLabel,
              })}
            >
              <span className="text-xs">{settledLabel}</span>
              <IconChevronDown
                size={14}
                className={cn(
                  'text-blue-500 transition-transform duration-200 ease-out',
                  pickerOpen && 'rotate-180'
                )}
              />
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
              {/* Every level is rendered on one stacked cell so the heading
                  neither jumps in width nor swaps text mid-drag: the outgoing
                  name lifts away while the incoming one rises into place. */}
              <span className="grid">
                {levels.map((option, index) => (
                  <span
                    key={option}
                    aria-hidden={option !== level}
                    className={cn(
                      'col-start-1 row-start-1 font-medium transition-[opacity,translate,color] duration-150 ease-out motion-reduce:transition-none',
                      option === level
                        ? 'translate-y-0 opacity-100'
                        : index < levelIndex
                          ? '-translate-y-1 opacity-0'
                          : 'translate-y-1 opacity-0',
                      option === 'max' && 'text-blue-500'
                    )}
                  >
                    {t(`common:reasoningEffort.${option}`)}
                  </span>
                ))}
              </span>
            </div>
            {levels.length > 1 && (
              <>
                <div className="text-muted-foreground mt-2 flex items-center justify-between text-[11px]">
                  <span>{t('common:reasoningEffort.faster')}</span>
                  <span>{t('common:reasoningEffort.smarter')}</span>
                </div>
                <SliderPrimitive.Root
                  className={cn(
                    'relative mt-1 flex h-6 w-full touch-none items-center select-none',
                    // Radix positions the thumb wrapper — the root's last child
                    // — with `left`, so the glide has to be animated there and
                    // not on the thumb we style. Under the pointer it is off, so
                    // the thumb sits exactly where the finger is.
                    // Class names have to be spelled out for Tailwind's
                    // scanner, so this repeats GLIDE rather than composing it.
                    gliding &&
                      '[&>span:last-child]:transition-[left] [&>span:last-child]:duration-300 [&>span:last-child]:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:[&>span:last-child]:transition-none'
                  )}
                  min={0}
                  max={lastIndex * SUBSTEPS}
                  step={1}
                  value={[position]}
                  // Free-running starts at the first move, not at the press:
                  // a click on the track still glides to where it landed, and
                  // only an actual drag pins the thumb to the pointer.
                  onPointerMove={(event) => {
                    const target = event.target as Element
                    if (target.hasPointerCapture?.(event.pointerId))
                      setDragging(true)
                  }}
                  onPointerUp={settle}
                  onPointerCancel={settle}
                  onLostPointerCapture={settle}
                  onKeyDown={handleKeyDown}
                  onValueChange={([next]) => {
                    moveTo(next)
                    applyIndex(Math.round(next / SUBSTEPS))
                  }}
                  onValueCommit={settle}
                >
                  <SliderPrimitive.Track className="bg-muted relative h-6 w-full grow rounded-full">
                    <SliderPrimitive.Range
                      className={cn(
                        'bg-muted-foreground/20 absolute h-full rounded-full',
                        // Radix sizes the fill with `left`/`right`, not width.
                        gliding &&
                          `transition-[left,right] ${GLIDE} motion-reduce:transition-none`
                      )}
                    />
                    {/* Blue belongs to the top tier alone, and fades in over the
                        grey fill rather than snapping on. */}
                    <div
                      aria-hidden
                      className={cn(
                        'pointer-events-none absolute inset-0 rounded-full bg-linear-to-r from-blue-500/10 via-blue-500/55 to-blue-500 transition-opacity duration-300 ease-out motion-reduce:transition-none',
                        isMax ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    {/* Stops line up with where the thumb can actually sit:
                        inset by half the thumb (12px) minus half a dot (2px). */}
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-[10px]">
                      {levels.map((option, index) => (
                        <span
                          key={option}
                          className={cn(
                            'size-1 rounded-full transition-colors duration-300 ease-out motion-reduce:transition-none',
                            index === lastIndex && !isMax
                              ? 'bg-blue-500'
                              : 'bg-muted-foreground/30'
                          )}
                        />
                      ))}
                    </div>
                  </SliderPrimitive.Track>
                  <SliderPrimitive.Thumb
                    aria-label={t('common:reasoningEffort.title')}
                    aria-valuemin={0}
                    aria-valuenow={levelIndex}
                    aria-valuemax={lastIndex}
                    aria-valuetext={levelLabel}
                    className="bg-background ring-ring/50 block h-5 w-6 rounded-lg shadow-md outline-hidden transition-shadow duration-200 ease-out hover:shadow-lg focus-visible:ring-4"
                  />
                </SliderPrimitive.Root>
              </>
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
})

export default ReasoningToggle
