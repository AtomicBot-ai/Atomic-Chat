import { memo, useEffect } from 'react'
import {
  IconLoader2,
  IconMicrophone,
  IconMicrophoneFilled,
  IconMicrophoneOff,
} from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { VOICE_ACTIVE_PHASES } from '@/constants/voice'
import { ensureVoiceReady, useVoiceInput } from '@/hooks/useVoiceInput'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { cn } from '@/lib/utils'
import { voiceErrorMessageKey } from '@/lib/voice/errors'
import type { DictationAnchor } from '@/lib/voice/promptMerge'

type VoiceInputToggleProps = {
  className?: string
  /** Which composer owns the microphone — `ChatInput`'s `agentModeKey`. */
  threadKey: string
  /** Reads the caret position at the moment recording starts. */
  captureAnchor: () => DictationAnchor
  /** A reply is streaming: the shared engine should not be asked to do both. */
  disabled?: boolean
}

/** Phases where the button is busy but not yet listening. */
const PENDING_PHASES = new Set(['checking', 'requesting-permission', 'starting'])

const VoiceInputToggle = memo(function VoiceInputToggle({
  className,
  threadKey,
  captureAnchor,
  disabled = false,
}: VoiceInputToggleProps) {
  const { t } = useTranslation()

  const phase = useVoiceInput((state) => state.phase)
  const ownerKey = useVoiceInput((state) => state.ownerKey)
  const error = useVoiceInput((state) => state.error)
  const stop = useVoiceInput((state) => state.stop)

  const owned = ownerKey === threadKey
  const recording = owned && VOICE_ACTIVE_PHASES.has(phase)
  const pending = owned && PENDING_PHASES.has(phase)
  const failed = owned && phase === 'error'

  // Surface failures once, here, so every entry point into the state machine
  // gets the same toast without repeating it.
  useEffect(() => {
    if (!failed || !error) return
    toast.error(t(voiceErrorMessageKey(error.code)), {
      description: error.message,
    })
    const id = setTimeout(() => useVoiceInput.getState().reset(), 2_000)
    return () => clearTimeout(id)
  }, [failed, error, t])

  if (!PlatformFeatures[PlatformFeature.VOICE_INPUT]) return null

  const label = recording
    ? t('common:voiceInput.stop')
    : disabled
      ? t('common:voiceInput.unavailableWhileStreaming')
      : pending
        ? t('common:voiceInput.preparing')
        : t('common:voiceInput.start')

  const handleClick = () => {
    if (pending) return
    if (recording) {
      void stop()
      return
    }
    void ensureVoiceReady(threadKey, captureAnchor())
  }

  const icon = pending ? (
    <IconLoader2 size={18} className="animate-spin text-muted-foreground" />
  ) : recording ? (
    <IconMicrophoneFilled size={18} className="text-destructive" />
  ) : failed ? (
    <IconMicrophoneOff size={18} className="text-destructive" />
  ) : (
    <IconMicrophone size={18} className="text-muted-foreground" />
  )

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              // Recording is the one thing in this toolbar that should read
              // as "hot". Same shape as the web-search toggle's active pill,
              // with `destructive` in place of blue.
              recording &&
                'text-destructive hover:text-destructive bg-destructive/10 hover:bg-destructive/15',
              failed && 'bg-destructive/10',
              className
            )}
            aria-label={label}
            aria-pressed={recording}
            disabled={disabled && !recording}
            onClick={handleClick}
          >
            {icon}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
})

export default VoiceInputToggle
