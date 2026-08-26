import { memo, useEffect, useRef } from 'react'

import { useVoiceInput } from '@/hooks/useVoiceInput'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

const BARS = 5
/** Never collapse to nothing — a flat meter reads as "broken", not "quiet". */
const FLOOR = 0.15
/** Centre bars react more than the edges, which is what reads as a level meter. */
const WEIGHTS = [0.55, 0.8, 1, 0.8, 0.55]

/** Push level updates into a callback; returns an unsubscribe. */
export type LevelSource = (onLevel: (level: number) => void) => () => void

const dictationLevel: LevelSource = (onLevel) =>
  useVoiceInput.subscribe((state) => onLevel(state.level))

type VoiceLevelMeterProps = {
  className?: string
  /**
   * Where the level comes from. Defaults to the dictation session; the settings
   * page passes the microphone-test monitor instead.
   */
  source?: LevelSource
  /** Bar colour. Recording is destructive-red; a device test is not. */
  tone?: 'recording' | 'neutral'
}

/**
 * Five bars driven by the microphone level.
 *
 * The level arrives ~20 times a second. Selecting it reactively would re-render
 * `ChatInput` — a 2900-line component — on every audio frame, so this subscribes
 * to the store imperatively and writes `transform` straight onto the DOM
 * instead. React renders this component once per session.
 */
const VoiceLevelMeter = memo(function VoiceLevelMeter({
  className,
  source = dictationLevel,
  tone = 'recording',
}: VoiceLevelMeterProps) {
  const { t } = useTranslation()
  const barsRef = useRef<Array<HTMLSpanElement | null>>([])

  useEffect(() => {
    const apply = (level: number) => {
      // Perceptual, not linear: speech sits low in the 0..1 RMS range, and a
      // linear meter would barely move.
      const normalized = Math.min(1, Math.sqrt(Math.max(0, level)) * 1.8)
      for (let i = 0; i < BARS; i++) {
        const bar = barsRef.current[i]
        if (!bar) continue
        const scale = FLOOR + (1 - FLOOR) * normalized * WEIGHTS[i]
        bar.style.transform = `scaleY(${scale.toFixed(3)})`
      }
    }

    apply(0)
    return source(apply)
  }, [source])

  return (
    <div
      className={cn('flex h-4 items-center gap-[3px]', className)}
      role="img"
      aria-label={t('common:voiceInput.level')}
    >
      {Array.from({ length: BARS }).map((_, index) => (
        <span
          key={index}
          ref={(element) => {
            barsRef.current[index] = element
          }}
          className={cn(
            'h-full w-[3px] origin-center rounded-full transition-transform duration-75',
            tone === 'recording' ? 'bg-destructive/70' : 'bg-primary/70'
          )}
          style={{ transform: `scaleY(${FLOOR})` }}
        />
      ))}
    </div>
  )
})

export default VoiceLevelMeter
