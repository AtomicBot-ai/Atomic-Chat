import { memo, useState } from 'react'
import {
  IconCircleCheckFilled,
  IconDownload,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ModelLogo } from '@/containers/ModelLogo'
import { VoiceSetupRow } from '@/containers/VoiceSetupRow'
import { VOICE_MODEL_BYTES, VOICE_MODEL_NAME } from '@/constants/voice'
import { useVoiceModel } from '@/hooks/useVoiceModel'
import { useTranslation } from '@/i18n/react-i18next-compat'

type VoiceModelCardProps = {
  /** `dialog` draws its own bordered row; `settings` is bare for a CardItem. */
  variant: 'dialog' | 'settings'
  className?: string
}

/** GB the way the rest of the app renders them — binary, two decimals. */
function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(2)
}

/**
 * Install / progress / remove for the one voice model.
 *
 * Shared by the setup wizard and the settings page so the two can never drift
 * out of sync, and so the download logic exists exactly once.
 */
const VoiceModelCard = memo(function VoiceModelCard({
  variant,
  className,
}: VoiceModelCardProps) {
  const { t } = useTranslation()
  const {
    installed,
    downloading,
    progress,
    currentBytes,
    totalBytes,
    download,
    cancelDownload,
    remove,
  } = useVoiceModel()

  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)

  const percent = Math.round(progress * 100)

  const handleRemove = async () => {
    setRemoving(true)
    try {
      await remove()
      setConfirmRemove(false)
    } catch (error) {
      toast.error(t('settings:voice.removeFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setRemoving(false)
    }
  }

  const actions = downloading ? (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        onClick={cancelDownload}
        aria-label={t('common:cancelDownload')}
        className="group relative w-24 justify-center overflow-hidden font-semibold"
      >
        <span
          className="absolute inset-y-0 left-0 z-0 bg-primary/20 transition-[width] duration-200"
          style={{ width: `${percent}%` }}
        />
        <span className="relative z-10 tabular-nums group-hover:hidden">
          {percent}%
        </span>
        <IconX size={14} className="relative z-10 hidden group-hover:block" />
      </Button>
      <p
        className="text-right text-xs tabular-nums text-muted-foreground"
        aria-live="polite"
      >
        {t('common:voiceInput.setup.model.progress', {
          percent,
          current: gb(currentBytes),
          total: gb(totalBytes),
        })}
      </p>
    </div>
  ) : installed ? (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <IconCircleCheckFilled size={16} />
        {t('common:voiceInput.setup.model.installed')}
      </span>
      {variant === 'settings' && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('settings:voice.remove')}
          onClick={() => setConfirmRemove(true)}
        >
          <IconTrash size={18} className="text-muted-foreground" />
        </Button>
      )}
    </div>
  ) : (
    // Primary in the wizard, where downloading is the one thing that step is
    // asking for; outline in settings, where it is one row among many.
    <Button
      variant={variant === 'dialog' ? 'default' : 'outline'}
      size="sm"
      onClick={() => void download()}
    >
      {variant === 'dialog' && <IconDownload size={16} />}
      {t('hub:download')}
    </Button>
  )

  const body =
    variant === 'settings' ? (
      actions
    ) : (
      <VoiceSetupRow
        className={className}
        // The publisher's mark, not a generic microphone glyph: it is the same
        // model the Hub lists, and the logo is what makes it recognizable as
        // "a model" rather than "a file the app wants to download".
        media={
          <ModelLogo
            name={VOICE_MODEL_NAME}
            icon="mistral"
            className="size-10 rounded-lg"
          />
        }
        title={VOICE_MODEL_NAME}
        description={
          <>
            {t('common:voiceInput.setup.model.tagline')}
            <span className="mx-1.5 text-muted-foreground/50">·</span>
            <span className="whitespace-nowrap tabular-nums">
              {t('common:voiceInput.setup.model.sizeGb', {
                size: gb(VOICE_MODEL_BYTES),
              })}
            </span>
          </>
        }
        action={actions}
      />
    )

  return (
    <>
      {body}
      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings:voice.removeTitle')}</DialogTitle>
            <DialogDescription>
              {t('settings:voice.removeDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmRemove(false)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={removing}
              onClick={() => void handleRemove()}
            >
              {t('settings:voice.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
})

export default VoiceModelCard
