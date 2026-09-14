import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
    levels: modelLevels,
    level: storedLevel,
  } = useReasoningEffort()

  // "Off" leads the scale: the fastest answer is one with no thinking phase
  // at all. A model without one has no scale to offer.
  const levels = useMemo<ReasoningBudgetLevel[]>(
    () => (modelLevels.length ? ['off', ...modelLevels] : []),
    [modelLevels]
  )
  const level: ReasoningBudgetLevel | undefined = modelLevels.length
    ? enabled && storedLevel
      ? storedLevel
      : 'off'
    : undefined
  const levelLabel = level ? t(`common:reasoningEffort.${level}`) : undefined

  const isMax = level === 'max'
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
      if (!next || next === level) return
      if (next === 'off') {
        setDisableReasoning(true)
        return
      }
      if (!enabled) setDisableReasoning(false)
      setReasoningBudget(next)
    },
    [levels, level, enabled, setDisableReasoning, setReasoningBudget]
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

  if (!level) return null

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
              if (target.hasPointerCapture?.(event.pointerId)) setDragging(true)
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
    </div>
  )
})

export default ReasoningEffortPanel
