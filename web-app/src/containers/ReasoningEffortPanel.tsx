import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import * as SliderPrimitive from '@radix-ui/react-slider'

import {
  useGeneralSetting,
  type ReasoningBudgetLevel,
} from '@/hooks/useGeneralSetting'
import { useReasoningEffort } from '@/hooks/useReasoningEffort'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

type ReasoningEffortPanelProps = {
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

/**
 * The effort scale: an "Effort · Level" heading over a slider whose stops are
 * the levels the selected model can express. Lives inside the model pill's
 * panel, so it mounts when that panel opens and goes with it when it closes —
 * which is also what clears a drag the closing panel cut short.
 *
 * The first stop is "Off": it switches the thinking phase off, and any stop
 * past it switches it back on at that level — the only on/off control the
 * composer has. Renders nothing while no model is selected, or for a model
 * with no thinking phase.
 */
const ReasoningEffortPanel = memo(function ReasoningEffortPanel({
  className,
}: ReasoningEffortPanelProps) {
  const { t } = useTranslation()
  const setReasoningBudget = useGeneralSetting(
    (state) => state.setReasoningBudget
  )
  const setDisableReasoning = useGeneralSetting(
    (state) => state.setDisableReasoning
  )
  const {
    enabled,
    canDisable,
    preferenceDisabled,
    hasModel,
    levels: modelLevels,
    level: storedLevel,
  } = useReasoningEffort()

  // "Off" leads the scale: the fastest answer is one with no thinking phase
  // at all. A model without one has no scale to offer.
  const levels = useMemo<ReasoningBudgetLevel[]>(
    () =>
      modelLevels.length
        ? canDisable
          ? ['off', ...modelLevels]
          : modelLevels
        : [],
    [canDisable, modelLevels]
  )
  const level: ReasoningBudgetLevel | undefined = modelLevels.length
    ? enabled && storedLevel
      ? storedLevel
      : canDisable
        ? 'off'
        : modelLevels[0]
    : undefined
  const lastIndex = levels.length - 1
  const levelIndex = level ? levels.indexOf(level) : 0

  // While a pointer is down the thumb follows the fine-grained scale locally.
  // The model preference is committed from Radix's exact final value on
  // release. Keeping those two jobs separate avoids WebKit's pointer-up /
  // lost-capture ordering resetting cloud effort back to its previous level.
  const [dragging, setDragging] = useState(false)
  const [position, setPosition] = useState(levelIndex * SUBSTEPS)
  const previewIndex = dragging
    ? clampIndex(Math.round(position / SUBSTEPS), lastIndex)
    : levelIndex
  const displayLevel = levels[previewIndex] ?? level
  const levelLabel = displayLevel
    ? t(`common:reasoningEffort.${displayLevel}`)
    : undefined
  const isMax = displayLevel === 'max'
  const sliderPosition = dragging ? position : levelIndex * SUBSTEPS

  // Radix only learns the thumb's width after its first paint, and then nudges
  // `left` by half of it. With the glide already live that correction plays as
  // a slide of up to half a thumb every time the panel opens, so it waits for
  // the layout to settle first.
  const [glide, setGlide] = useState(false)
  useEffect(() => {
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
  }, [])
  /** Motion the control makes on its own, as opposed to under the pointer. */
  const gliding = glide && !dragging

  // Off flips the switch and leaves the stored level alone, so the settings
  // that read it keep it, and a model picked later starts from it.
  const applyIndex = useCallback(
    (index: number) => {
      const next = levels[clampIndex(index, levels.length - 1)]
      if (!next) return
      if (next === 'off') {
        if (next === level) return
        setDisableReasoning(true)
        return
      }
      // A required-thinking API displays its weakest effort even while a
      // fresh profile still carries the global `disableReasoning: true`
      // default. Clear that persisted flag when the user chooses an effort;
      // otherwise the capability resolver keeps forcing the first level and
      // the slider appears to snap back until a local model has been used.
      if (preferenceDisabled) setDisableReasoning(false)
      if (next === level && !preferenceDisabled) return
      setReasoningBudget(next)
    },
    [
      levels,
      level,
      preferenceDisabled,
      setDisableReasoning,
      setReasoningBudget,
    ]
  )

  /** Commit the exact value Radix reports at the end of a pointer pass. */
  const commitPosition = useCallback(
    (next: number) => {
      const index = clampIndex(Math.round(next / SUBSTEPS), lastIndex)
      applyIndex(index)
      setPosition(index * SUBSTEPS)
      setDragging(false)
    },
    [applyIndex, lastIndex]
  )

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
    setPosition(index * SUBSTEPS)
    applyIndex(index)
  }

  if (!hasModel) return null

  if (!level) {
    return (
      <div
        className={cn(className, 'opacity-60')}
        data-test-id="reasoning-effort-panel"
        aria-disabled="true"
      >
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">
            {t('common:reasoningEffort.title')}
          </span>
          <span className="font-medium text-muted-foreground">
            {t('common:reasoningEffort.unavailable')}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className={className} data-test-id="reasoning-effort-panel">
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
              aria-hidden={option !== displayLevel}
              className={cn(
                'col-start-1 row-start-1 font-medium transition-[opacity,translate,color] duration-150 ease-out motion-reduce:transition-none',
                option === displayLevel
                  ? 'translate-y-0 opacity-100'
                  : index < previewIndex
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
            value={[sliderPosition]}
            onKeyDown={handleKeyDown}
            onValueChange={([next]) => {
              setDragging(true)
              setPosition(next)
            }}
            onValueCommit={([next]) => commitPosition(next)}
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
              aria-valuenow={previewIndex}
              aria-valuemax={lastIndex}
              aria-valuetext={levelLabel}
              className="bg-background ring-ring/50 block h-5 w-6 rounded-lg shadow-md outline-hidden transition-shadow duration-200 ease-out hover:shadow-lg focus-visible:ring-4"
            />
          </SliderPrimitive.Root>
        </>
      )}
    </div>
  )
})

export default ReasoningEffortPanel
