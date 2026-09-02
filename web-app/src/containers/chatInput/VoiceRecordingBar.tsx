import { memo } from 'react'
import { IconPlayerStopFilled, IconX } from '@tabler/icons-react'

import VoiceElapsedTimer from '@/containers/chatInput/VoiceElapsedTimer'
import VoiceLevelMeter from '@/containers/chatInput/VoiceLevelMeter'
import { Button } from '@/components/ui/button'
import { VOICE_ACTIVE_PHASES } from '@/constants/voice'
import { useVoiceInput } from '@/hooks/useVoiceInput'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

type VoiceRecordingBarProps = {
  /** The composer this bar belongs to — `ChatInput`'s `agentModeKey`. */
  threadKey: string
  className?: string
}

/**
 * The recording strip, shown inside the composer body while dictation runs.
 *
 * Deliberately *not* in the toolbar's left cluster: that cluster is disabled
 * wholesale while a reply streams (`opacity-50 pointer-events-none`), which
 * would leave an in-flight recording with no way to stop it.
 */
const VoiceRecordingBar = memo(function VoiceRecordingBar({
  threadKey,
  className,
}: VoiceRecordingBarProps) {
  const { t } = useTranslation()

  const phase = useVoiceInput((state) => state.phase)
  const ownerKey = useVoiceInput((state) => state.ownerKey)
  const interim = useVoiceInput((state) => state.interim)
  const segmentInFlight = useVoiceInput((state) => state.segmentInFlight)
  const stop = useVoiceInput((state) => state.stop)
  const cancel = useVoiceInput((state) => state.cancel)

  if (ownerKey !== threadKey || !VOICE_ACTIVE_PHASES.has(phase)) return null

  // The model transcribes a phrase only once it is finished, so the gap
  // between speaking and seeing the words is real. Saying so is the difference
  // between "it is working on it" and "it is broken".
  const status =
    phase === 'starting'
      ? t('common:voiceInput.starting')
      : phase === 'transcribing' || phase === 'finalizing' || segmentInFlight
        ? t('common:voiceInput.transcribing')
        : t('common:voiceInput.listening')

  return (
    <div
      data-testid="voice-recording-bar"
      role="status"
      aria-live="polite"
      className={cn('flex items-center gap-3 px-4 pt-1 pb-0.5', className)}
    >
      {/* Pulsing record dot. */}
      <span className="relative flex size-2 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive/60" />
        <span className="relative inline-flex size-2 rounded-full bg-destructive" />
      </span>

      <VoiceLevelMeter className="shrink-0" />

      {/* The phrase being transcribed. It lives here rather than in the
          textarea: a plain <textarea> cannot style a substring, so provisional
          text inside the box would be indistinguishable from committed text. */}
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {interim || status}
      </span>

      <VoiceElapsedTimer className="shrink-0 text-xs text-muted-foreground" />

      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('common:voiceInput.cancel')}
        onClick={() => void cancel()}
      >
        <IconX size={16} className="text-muted-foreground" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('common:voiceInput.stop')}
        onClick={() => void stop()}
        className="text-destructive hover:text-destructive bg-destructive/10 hover:bg-destructive/15"
      >
        <IconPlayerStopFilled size={16} />
      </Button>
    </div>
  )
})

export default VoiceRecordingBar
