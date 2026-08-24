import { memo, useCallback, useEffect, useState } from 'react'
import {
  IconCheck,
  IconCircleCheckFilled,
  IconExternalLink,
  IconLoader2,
  IconMicrophone,
} from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import VoiceModelCard from '@/containers/VoiceModelCard'
import { VOICE_MODEL_FREE_DISK_GB } from '@/constants/voice'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useVoiceInput, type VoiceSetupStep } from '@/hooks/useVoiceInput'
import { useVoiceSetting } from '@/hooks/useVoiceSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

const TOTAL_STEPS = 3

/**
 * Progress dots.
 *
 * There is no Stepper primitive in this app, so this is new — built from the
 * same dot row the reasoning-effort popover uses. The dots are `aria-hidden`
 * and paired with a screen-reader-only "Step 2 of 3": `role="tablist"` would
 * misrepresent the interaction, since you cannot jump between steps.
 */
function StepDots({ step }: { step: number }) {
  const { t } = useTranslation()
  return (
    <>
      <div className="flex items-center justify-center gap-1.5" aria-hidden>
        {Array.from({ length: TOTAL_STEPS }).map((_, index) => (
          <span
            key={index}
            className={cn(
              'h-1.5 rounded-full transition-all duration-200',
              index === step ? 'w-5 bg-primary' : 'w-1.5 bg-muted-foreground/30'
            )}
          />
        ))}
      </div>
      <span className="sr-only">
        {t('common:voiceInput.setup.step', {
          current: step + 1,
          total: TOTAL_STEPS,
        })}
      </span>
    </>
  )
}

/**
 * Microphone permission, with a way back when it has been denied.
 *
 * macOS only ever prompts once, so "denied" is a dead end unless we hand the
 * user a link into the privacy pane. Exported because the settings page needs
 * exactly the same block.
 */
export const VoicePermissionBlock = memo(function VoicePermissionBlock() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const permission = useVoiceInput((state) => state.permission)
  const setPermission = useVoiceInput((state) => state.setPermission)
  const refreshPermission = useVoiceInput((state) => state.refreshPermission)
  const setMicPermissionAsked = useVoiceSetting(
    (state) => state.setMicPermissionAsked
  )
  const [requesting, setRequesting] = useState(false)

  const canOpenSettings = serviceHub.voice().canOpenSystemMicrophoneSettings()

  useEffect(() => {
    void refreshPermission()
  }, [refreshPermission])

  const request = async () => {
    setRequesting(true)
    try {
      const result = await serviceHub.voice().requestPermission()
      setPermission(result)
      setMicPermissionAsked(true)
    } finally {
      setRequesting(false)
    }
  }

  if (permission === 'granted') {
    return (
      <div className="flex items-center justify-center gap-2 rounded-md border bg-secondary p-3 text-sm font-medium text-emerald-600 dark:text-emerald-400">
        <IconCircleCheckFilled size={18} />
        {t('common:voiceInput.setup.permission.allowed')}
      </div>
    )
  }

  if (permission === 'denied') {
    return (
      <div className="rounded-md border bg-secondary p-3 text-sm">
        <p className="font-medium text-destructive">
          {t('common:voiceInput.setup.permission.denied')}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('common:voiceInput.setup.permission.deniedHelp')}
        </p>
        {IS_MACOS && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('common:voiceInput.setup.permission.restartNote')}
          </p>
        )}
        <div className="mt-3 flex gap-2">
          {canOpenSettings && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void serviceHub.voice().openSystemMicrophoneSettings()
              }
            >
              <IconExternalLink size={14} />
              {t('common:voiceInput.setup.permission.openSystemSettings')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refreshPermission()}
          >
            {t('common:voiceInput.setup.permission.checkAgain')}
          </Button>
        </div>
      </div>
    )
  }

  if (permission === 'unsupported') {
    return (
      <div className="rounded-md border bg-secondary p-3 text-sm text-muted-foreground">
        {t('common:voiceInput.setup.permission.unsupported')}
      </div>
    )
  }

  return (
    <div className="rounded-md border bg-secondary p-3">
      <Button
        size="sm"
        className="w-full"
        disabled={requesting}
        onClick={() => void request()}
      >
        {requesting ? (
          <>
            <IconLoader2 size={16} className="animate-spin" />
            {t('common:voiceInput.setup.permission.requesting')}
          </>
        ) : (
          <>
            <IconMicrophone size={16} />
            {t('common:voiceInput.setup.permission.allow')}
          </>
        )}
      </Button>
    </div>
  )
})

function IntroStep() {
  const { t } = useTranslation()
  const bullets = [
    'common:voiceInput.setup.intro.bulletLive',
    'common:voiceInput.setup.intro.bulletLocal',
    'common:voiceInput.setup.intro.bulletAnywhere',
  ]

  return (
    <>
      <div className="flex justify-center py-2">
        <div className="grid size-12 place-items-center rounded-xl bg-secondary">
          <IconMicrophone size={24} className="text-foreground" />
        </div>
      </div>
      <p className="text-sm font-medium">
        {t('common:voiceInput.setup.intro.title')}
      </p>
      <p className="text-sm text-muted-foreground">
        {t('common:voiceInput.setup.intro.description')}
      </p>
      <div className="space-y-3">
        {bullets.map((key) => (
          <div key={key} className="flex items-start gap-2.5">
            <IconCheck
              size={16}
              className="mt-0.5 shrink-0 text-muted-foreground"
            />
            <span className="text-sm text-muted-foreground">{t(key)}</span>
          </div>
        ))}
      </div>
    </>
  )
}

/**
 * Three-step first-run flow: what it does, microphone access, install the model.
 *
 * Mounted once globally rather than inside the composer, because the settings
 * page has to be able to reopen it with no composer on screen.
 */
const VoiceSetupDialog = memo(function VoiceSetupDialog() {
  const { t } = useTranslation()

  const open = useVoiceInput((state) => state.setupOpen)
  const step = useVoiceInput((state) => state.setupStep)
  const openSetup = useVoiceInput((state) => state.openSetup)
  const closeSetup = useVoiceInput((state) => state.closeSetup)
  const setSetupCompleted = useVoiceSetting((state) => state.setSetupCompleted)

  const go = useCallback(
    (next: number) => openSetup(Math.min(2, Math.max(0, next)) as VoiceSetupStep),
    [openSetup]
  )

  const finish = useCallback(() => {
    // Closing early is safe: the next click on the microphone re-derives which
    // prerequisite is still missing and reopens the dialog right there.
    setSetupCompleted(true)
    closeSetup()
  }, [closeSetup, setSetupCompleted])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? openSetup(step) : finish())}
    >
      <DialogContent className="sm:max-w-md lg:max-w-md xl:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('common:voiceInput.setup.title')}</DialogTitle>
          <DialogDescription>
            {t('common:voiceInput.setup.subtitle')}
          </DialogDescription>
        </DialogHeader>

        {/* Fixed floor so the dots and footer do not jump between steps. */}
        <div className="min-h-[268px] space-y-5 py-2">
          {step === 0 && <IntroStep />}

          {step === 1 && (
            <>
              <p className="text-sm font-medium">
                {t('common:voiceInput.setup.permission.title')}
              </p>
              <p className="text-sm text-muted-foreground">
                {t('common:voiceInput.setup.permission.description')}
              </p>
              <VoicePermissionBlock />
            </>
          )}

          {step === 2 && (
            <>
              <p className="text-sm font-medium">
                {t('common:voiceInput.setup.model.title')}
              </p>
              <p className="text-sm text-muted-foreground">
                {t('common:voiceInput.setup.model.description')}
              </p>
              <VoiceModelCard variant="dialog" />
              <p className="text-xs text-muted-foreground">
                {t('common:voiceInput.setup.model.diskNote', {
                  gb: VOICE_MODEL_FREE_DISK_GB,
                })}
              </p>
            </>
          )}
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <StepDots step={step} />
          <div className="flex gap-2">
            {step > 0 && (
              <Button variant="ghost" size="sm" onClick={() => go(step - 1)}>
                {t('common:voiceInput.setup.back')}
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => (step === 2 ? finish() : go(step + 1))}
            >
              {step === 2
                ? t('common:voiceInput.setup.done')
                : t('common:voiceInput.setup.next')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default VoiceSetupDialog
