import { memo, useCallback, useEffect, useState } from 'react'
import {
  IconCircleCheckFilled,
  IconDownload,
  IconExternalLink,
  IconLoader2,
  IconLock,
  IconMicrophone,
  IconWaveSine,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import VoiceModelCard from '@/containers/VoiceModelCard'
import { VoiceSetupRow, VoiceSetupRowIcon } from '@/containers/VoiceSetupRow'
import { VOICE_MODEL_FREE_DISK_GB } from '@/constants/voice'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useVoiceInput, type VoiceSetupStep } from '@/hooks/useVoiceInput'
import { useVoiceModel } from '@/hooks/useVoiceModel'
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
  // One element, not a fragment: the footer is a three-column grid, and a
  // stray sr-only sibling would take a column of its own and push the buttons
  // onto a second row.
  return (
    <div className="flex items-center justify-center">
      <div className="flex items-center gap-2" aria-hidden>
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
    </div>
  )
}

type VoicePermissionBlockProps = {
  /**
   * `dialog` is the prerequisite row of the wizard's step 2. `settings` is the
   * recovery panel the settings page hangs under the permission row, and is
   * only ever mounted while access is denied.
   */
  variant?: 'dialog' | 'settings'
}

/**
 * Microphone permission, with a way back when it has been denied.
 *
 * macOS only ever prompts once, so "denied" is a dead end unless we hand the
 * user a link into the privacy pane. Exported because the settings page needs
 * exactly the same recovery block.
 */
export const VoicePermissionBlock = memo(function VoicePermissionBlock({
  variant = 'dialog',
}: VoicePermissionBlockProps) {
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

  // Everything the user can do about a refusal: the privacy pane, and a
  // re-check for when they come back from it.
  const recovery = (
    <>
      <p className="text-xs leading-snug text-muted-foreground">
        {t('common:voiceInput.setup.permission.deniedHelp')}
        {IS_MACOS && ` ${t('common:voiceInput.setup.permission.restartNote')}`}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
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
    </>
  )

  if (variant === 'settings') {
    // The settings page renders this under its own permission row, which
    // already says "Denied" — so this is the recovery panel and nothing else.
    if (permission !== 'denied') return null
    return <div className="rounded-md border bg-secondary p-3">{recovery}</div>
  }

  /** Right-hand slot: the state we are in, or the one button that changes it. */
  const action =
    permission === 'granted' ? (
      <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <IconCircleCheckFilled size={16} />
        {t('common:voiceInput.setup.permission.allowed')}
      </span>
    ) : permission === 'denied' ? (
      <span className="text-xs font-medium text-destructive">
        {t('common:voiceInput.setup.permission.deniedShort')}
      </span>
    ) : permission === 'unsupported' ? (
      <span className="text-xs font-medium text-muted-foreground">
        {t('common:voiceInput.setup.permission.unsupportedShort')}
      </span>
    ) : (
      // Short label in the row — the full "Allow microphone" pushed the
      // description into three lines in the longer locales. The button still
      // announces itself in full.
      <Button
        size="sm"
        disabled={requesting}
        aria-label={t('common:voiceInput.setup.permission.allow')}
        onClick={() => void request()}
      >
        {requesting ? (
          <IconLoader2 size={16} className="animate-spin" />
        ) : (
          <IconMicrophone size={16} />
        )}
        {t('common:voiceInput.setup.permission.allowShort')}
      </Button>
    )

  return (
    <VoiceSetupRow
      media={
        <VoiceSetupRowIcon>
          <IconMicrophone size={20} />
        </VoiceSetupRowIcon>
      }
      title={t('common:voiceInput.setup.permission.rowTitle')}
      description={
        // Denied swaps this line for the recovery block underneath, which says
        // more about what to do next than the standing description does.
        permission === 'denied'
          ? undefined
          : t('common:voiceInput.setup.permission.rowDescription')
      }
      action={action}
      footer={
        permission === 'denied' ? (
          recovery
        ) : permission === 'unsupported' ? (
          <p className="text-xs leading-snug text-muted-foreground">
            {t('common:voiceInput.setup.permission.unsupported')}
          </p>
        ) : undefined
      }
    />
  )
})

/**
 * What dictation is, in three rows built like the prerequisite rows on the two
 * steps that follow — so paging through the wizard reads as one object being
 * filled in, not three unrelated layouts.
 */
const INTRO_BULLETS = [
  {
    icon: IconWaveSine,
    text: 'common:voiceInput.setup.intro.bulletLive',
  },
  {
    icon: IconLock,
    text: 'common:voiceInput.setup.intro.bulletLocal',
  },
  {
    icon: IconMicrophone,
    text: 'common:voiceInput.setup.intro.bulletAnywhere',
  },
] as const

function IntroStep() {
  const { t } = useTranslation()
  return (
    <div className="space-y-2 rounded-xl border bg-secondary/40 p-3">
      {INTRO_BULLETS.map(({ icon: Icon, text }) => (
        <div key={text} className="flex items-center gap-3">
          <VoiceSetupRowIcon size="sm">
            <Icon size={16} />
          </VoiceSetupRowIcon>
          <span className="text-sm leading-snug text-muted-foreground">
            {t(text)}
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
  const permission = useVoiceInput((state) => state.permission)
  const openSetup = useVoiceInput((state) => state.openSetup)
  const closeSetup = useVoiceInput((state) => state.closeSetup)
  const setSetupCompleted = useVoiceSetting((state) => state.setSetupCompleted)
  const { installed } = useVoiceModel()

  const go = useCallback(
    (next: number) =>
      openSetup(Math.min(2, Math.max(0, next)) as VoiceSetupStep),
    [openSetup]
  )

  const StepIcon = STEPS[step].icon

  // Both prerequisites are actually in place. `unsupported` counts as settled:
  // on a system that manages microphone access outside the app there is
  // nothing here left for the user to grant.
  const ready =
    (permission === 'granted' || permission === 'unsupported') && installed

  const finish = useCallback(() => {
    // Dismissing is safe even half-configured: the next click on the microphone
    // re-derives which prerequisite is still missing and reopens the dialog on
    // that step, instead of walking the whole wizard again.
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
            the cursor. Content is top-aligned rather than centred, so the card
            starts on the same line on every step instead of sliding up and
            down as you page. The denied-permission recovery — two notes and
            two buttons — is the one state given a box of its own: growing for
            a state change is fine, growing while paging is not. */}
        <div
          data-testid="voice-setup-slot"
          className={cn(
            'flex flex-col justify-start gap-2 overflow-y-auto py-1',
            step === 1 && permission === 'denied' ? 'h-[232px]' : 'h-[156px]'
          )}
        >
          {step === 0 && <IntroStep />}
          {step === 1 && (
            <>
              <VoicePermissionBlock />
              {/* The same footnote slot step 3 uses for its disk note, so the
                  two prerequisite steps sit at the same weight. Denied and
                  unsupported carry their own explanation in the card. */}
              {permission !== 'denied' && permission !== 'unsupported' && (
                <p className="text-center text-xs text-muted-foreground">
                  {t('common:voiceInput.setup.permission.privacyNote')}
                </p>
              )}
            </>
          )}
          {step === 2 && (
            <>
              <VoiceModelCard variant="dialog" />
              {!installed && (
                <p className="text-center text-xs text-muted-foreground">
                  {t('common:voiceInput.setup.model.diskNote', {
                    gb: VOICE_MODEL_FREE_DISK_GB,
                  })}
                </p>
              )}
            </>
          )}
        </div>

        {/* Three columns, not `justify-between`: the dots belong to the dialog,
            not to whichever buttons happen to be on this step, so they stay on
            the centre line whether or not Back is there. */}
        <DialogFooter className="grid grid-cols-3 items-center sm:flex-row sm:justify-between">
          <div className="flex justify-start">
            {step > 0 && (
              <Button variant="ghost" size="sm" onClick={() => go(step - 1)}>
                {t('common:voiceInput.setup.back')}
              </Button>
            )}
          </div>
          <StepDots step={step} />
          <div className="flex justify-end">
            {step === 2 ? (
              <Tooltip>
                {/* The trigger is the wrapper, not the button: a disabled
                    button fires no pointer events, and "why can't I finish?"
                    is exactly the question this tooltip answers. */}
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      size="sm"
                      disabled={!ready}
                      data-testid="voice-setup-done"
                      onClick={finish}
                    >
                      {t('common:voiceInput.setup.done')}
                    </Button>
                  </span>
                </TooltipTrigger>
                {!ready && (
                  // Aligned to the button's right edge: the wizard's Done sits
                  // in the corner, and a centred tooltip hangs off the dialog.
                  <TooltipContent align="end">
                    <p>{t('common:voiceInput.setup.doneBlocked')}</p>
                  </TooltipContent>
                )}
              </Tooltip>
            ) : (
              <Button size="sm" onClick={() => go(step + 1)}>
                {t('common:voiceInput.setup.next')}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default VoiceSetupDialog
