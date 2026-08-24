import { memo, useEffect, useState } from 'react'

import { useVoiceInput } from '@/hooks/useVoiceInput'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

type VoiceElapsedTimerProps = { className?: string }

function format(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

/**
 * Recording time.
 *
 * A leaf on purpose: it owns its own interval so the once-per-second tick never
 * reaches the composer. It selects `startedAt`, which changes once per session.
 */
const VoiceElapsedTimer = memo(function VoiceElapsedTimer({
  className,
}: VoiceElapsedTimerProps) {
  const { t } = useTranslation()
  const startedAt = useVoiceInput((state) => state.startedAt)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!startedAt) {
      setElapsed(0)
      return
    }
    const tick = () => setElapsed((Date.now() - startedAt) / 1000)
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [startedAt])

  return (
    <span
      className={cn('tabular-nums', className)}
      aria-label={t('common:voiceInput.elapsed')}
    >
      {format(elapsed)}
    </span>
  )
})

export default VoiceElapsedTimer
