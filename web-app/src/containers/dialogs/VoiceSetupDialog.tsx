import { memo, useCallback, useEffect, useState } from 'react'
import {
  IconCheck,
  IconCircleCheckFilled,
  IconDownload,
  IconExternalLink,
  IconLoader2,
  IconLock,
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
      <div className="flex items-center justify-center gap-2" aria-hidden>
        {Array.from({ length: TOTAL_STEPS }).map((_, index) => (
          <span
            key={index}
            className={cn(
              'size-2 rounded-full transition-colors duration-200',
              index === step ? 'bg-primary' : 'bg-muted-foreground/30'
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

const INTRO_BULLETS = [
  'common:voiceInput.setup.intro.bulletLive',
  'common:voiceInput.setup.intro.bulletLocal',
  'common:voiceInput.setup.intro.bulletAnywhere',
]

function IntroStep() {
  const { t } = useTranslation()
  return (
    <div className="space-y-2.5 rounded-md border bg-secondary p-3">
      {INTRO_BULLETS.map((key) => (
        <div key={key} className="flex items-start gap-2.5">
          <IconCheck
            size={16}
            className="mt-0.5 shrink-0 text-muted-foreground"
          />
          <span className="text-sm leading-snug text-muted-foreground">
            {t(key)}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * One shape for all three steps: an icon tile, a title, a one-line subtitle and
 * a single bordered block. Keeping the slots identical is what stops the dialog
 * resizing as you page through it — and it leaves room for exactly one sentence
 * per step, which is the amount of copy a wizard can carry.
 */
const STEPS = [
  {
    icon: IconMicrophone,
    title: 'common:voiceInput.setup.intro.title',
    description: 'common:voiceInput.setup.intro.description',
  },
  {
    icon: IconLock,
    title: 'common:voiceInput.setup.permission.title',
    description: 'common:voiceInput.setup.permission.description',
  },
  {
    icon: IconDownload,
    title: 'common:voiceInput.setup.model.title',
    description: 'common:voiceInput.setup.model.description',
  },
] as const

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

  const StepIcon = STEPS[step].icon

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
        {/* The step's own title carries the header. A fixed dialog title on top
            of a per-step heading meant four stacked blocks of text, which is
            what made this feel crowded. */}
        <DialogHeader
          data-testid="voice-setup-header"
          className="items-center text-center sm:text-center"
        >
          <div className="mb-1 grid size-12 place-items-center rounded-xl bg-secondary">
            <StepIcon size={24} className="text-foreground" />
          </div>
          <DialogTitle>{t(STEPS[step].title)}</DialogTitle>
          {/* Two lines of text-sm, fixed. The dialog is 400px wide inside its
              padding, so these descriptions land on one line or two depending
              on the string and the locale — and a step whose description wraps
              would otherwise sit taller than the ones that don't. The copy is
              length-checked in the tests so nothing here ever needs a third
              line. */}
          <DialogDescription
            data-testid="voice-setup-description"
            className="h-10 text-pretty"
          >
            {t(STEPS[step].description)}
          </DialogDescription>
        </DialogHeader>

        {/* A fixed height, not a minimum: with a floor the tallest step still
            stretched the dialog, so paging through it resized the window under
            the cursor. Every step's content is centred in the same box.
            `overflow-y-auto` only ever engages for the denied-permission block
            on macOS, which carries an extra restart note. */}
        <div
          data-testid="voice-setup-slot"
          className="flex h-[180px] flex-col justify-center gap-2 overflow-y-auto py-1"
        >
          {step === 0 && <IntroStep />}
          {step === 1 && <VoicePermissionBlock />}
          {step === 2 && (
            <>
              <VoiceModelCard variant="dialog" />
              <p className="text-center text-xs text-muted-foreground">
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
