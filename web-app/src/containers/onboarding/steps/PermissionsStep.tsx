import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  Bell,
  Check,
  ExternalLink,
  Folder,
  Mic,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  notificationPermissionGranted,
  requestNotificationPermission,
} from '@/lib/notifications'
import { captureOnboardingEvent } from '@/lib/onboarding-telemetry'
import {
  useOnboardingStore,
  type OnboardingPermissionResult,
} from '@/stores/onboarding-store'

import { usePermissionAvailability } from './permissionsAvailability'
import type { StepProps } from './types'
import '../permissions.css'

/** The rows that ask the OS for something. */
type AskablePermission = 'notifications' | 'microphone'

/** Where a row stands: not asked yet, the OS prompt is up, or answered. */
type RowState = 'idle' | 'asking' | OnboardingPermissionResult

/** What a user said to a row, as `onboarding_permission` reports it. */
type PermissionAnswer = OnboardingPermissionResult | 'not_now'

const ICONS: Record<AskablePermission | 'files', LucideIcon> = {
  notifications: Bell,
  microphone: Mic,
  files: Folder,
}

type PermissionsStepProps = StepProps & {
  /**
   * The shell's hold on "Skip setup" (`Onboarding`): the guard returns true
   * when it takes over, and the step then hands off itself if the user goes on.
   */
  guardSkipSetup?: (guard: (() => boolean) | null) => void
}

function reportAnswer(permission: AskablePermission, answer: PermissionAnswer) {
  captureOnboardingEvent('onboarding_permission', {
    permission,
    permission_result: answer,
  })
}

/**
 * "A little access. More possibilities.": notifications and the microphone,
 * asked for ahead of time with a word on why, and "Files & folders" explained
 * only — macOS cannot grant file access ahead of time, and an attachment is
 * picked one file at a time anyway. Everything is optional; leaving with
 * nothing allowed asks once whether that was meant.
 */
export function PermissionsStep({
  next,
  handOff,
  guardSkipSetup,
}: PermissionsStepProps) {
  const { t } = useTranslation()
  const voice = useServiceHub().voice()
  const availability = usePermissionAvailability()

  // An answer given earlier in this run stands until the OS says otherwise.
  const [states, setStates] = useState<Record<AskablePermission, RowState>>(
    () => {
      const answers = useOnboardingStore.getState().permissions
      return {
        notifications: answers.notifications ?? 'idle',
        microphone: answers.microphone ?? 'idle',
      }
    }
  )
  const setRow = (permission: AskablePermission, state: RowState) =>
    setStates((current) => ({ ...current, [permission]: state }))

  // Notifications already allowed show as such on arrival; one revoked since
  // it was allowed in this run can be asked for again.
  useEffect(() => {
    if (!availability.notifications) return
    let cancelled = false
    void notificationPermissionGranted().then((granted) => {
      if (cancelled) return
      setStates((current) => {
        if (granted) return { ...current, notifications: 'granted' }
        return current.notifications === 'granted'
          ? { ...current, notifications: 'idle' }
          : current
      })
    })
    return () => {
      cancelled = true
    }
  }, [availability.notifications])

  // The microphone's own answer, read without a prompt, is the row's.
  useEffect(() => {
    const os = availability.microphone
    if (os === null || os === 'unsupported') return
    setStates((current) =>
      current.microphone === 'asking'
        ? current
        : { ...current, microphone: os === 'undetermined' ? 'idle' : os }
    )
  }, [availability.microphone])

  const rows: AskablePermission[] = [
    ...(availability.notifications ? (['notifications'] as const) : []),
    ...(availability.microphone !== null &&
    availability.microphone !== 'unsupported'
      ? (['microphone'] as const)
      : []),
  ]
  const anyAllowed = rows.some((row) => states[row] === 'granted')

  // The explanation first; the OS prompt only once the user agreed to it. The
  // id outlives the dialog so it does not empty out while closing.
  const [explaining, setExplaining] =
    useState<AskablePermission>('notifications')
  const [explainOpen, setExplainOpen] = useState(false)
  const explain = (permission: AskablePermission) => {
    setExplaining(permission)
    setExplainOpen(true)
  }
  const notNow = () => {
    setExplainOpen(false)
    reportAnswer(explaining, 'not_now')
  }

  const request = async (permission: AskablePermission) => {
    setExplainOpen(false)
    setRow(permission, 'asking')
    let result: OnboardingPermissionResult
    try {
      const granted =
        permission === 'notifications'
          ? await requestNotificationPermission()
          : (await voice.requestPermission()) === 'granted'
      result = granted ? 'granted' : 'denied'
    } catch (error) {
      console.warn(`[onboarding] ${permission} request failed`, error)
      result = 'denied'
    }
    setRow(permission, result)
    useOnboardingStore.getState().setPermission(permission, result)
    reportAnswer(permission, result)
  }

  // Leaving with nothing allowed is confirmed first, whether by Continue or
  // by the shell's Skip setup.
  const [leaving, setLeaving] = useState<'next' | 'skip_setup' | null>(null)
  const anyAllowedRef = useRef(anyAllowed)
  anyAllowedRef.current = anyAllowed
  useEffect(() => {
    if (!guardSkipSetup) return
    guardSkipSetup(() => {
      if (anyAllowedRef.current) return false
      setLeaving('skip_setup')
      return true
    })
    return () => guardSkipSetup(null)
  }, [guardSkipSetup])

  const proceed = () => {
    if (anyAllowed) next('continue')
    else setLeaving('next')
  }
  const leaveWithout = () => {
    const via = leaving
    setLeaving(null)
    if (via === 'skip_setup') handOff('chat', 'skip_setup')
    else next('skip')
  }

  const canOpenMicrophoneSettings = voice.canOpenSystemMicrophoneSettings()
  const action = (permission: AskablePermission) => {
    const state = states[permission]
    if (state === 'granted') {
      return (
        <span className="ob-granted">
          <Check size={14} aria-hidden="true" />
          {t('onboarding-permissions:allowed')}
        </span>
      )
    }
    if (state === 'denied') {
      return (
        <>
          <span className="ob-permission-denied">
            {t('onboarding-permissions:notAllowed')}
          </span>
          {/* macOS asks only once; after a refusal the privacy pane is the
              only way back. */}
          {permission === 'microphone' && canOpenMicrophoneSettings && (
            <button
              type="button"
              className="ob-text"
              onClick={() =>
                void voice.openSystemMicrophoneSettings().catch((error) => {
                  console.warn('[onboarding] could not open settings', error)
                })
              }
            >
              {t('common:voiceInput.setup.permission.openSystemSettings')}
              <ExternalLink size={13} aria-hidden="true" />
            </button>
          )}
        </>
      )
    }
    return (
      <button
        type="button"
        className="ob-secondary"
        disabled={state === 'asking'}
        aria-describedby={`ob-permission-${permission}`}
        onClick={() => explain(permission)}
      >
        {state === 'asking'
          ? t('onboarding-permissions:asking')
          : t('onboarding-permissions:allow')}
      </button>
    )
  }

  const row = (
    permission: AskablePermission | 'files',
    side: React.ReactNode
  ) => {
    const Icon = ICONS[permission]
    return (
      <div className="ob-permission" key={permission}>
        <Icon size={23} aria-hidden="true" />
        <div className="ob-permission-text">
          <h3 id={`ob-permission-${permission}`}>
            {t(`onboarding-permissions:${permission}.title`)}
          </h3>
          <p>{t(`onboarding-permissions:${permission}.reason`)}</p>
        </div>
        <div className="ob-permission-action">{side}</div>
      </div>
    )
  }

  const ExplainIcon = ICONS[explaining]

  return (
    <>
      <h1 tabIndex={-1}>{t('onboarding-permissions:title')}</h1>
      <p className="ob-lead">{t('onboarding-permissions:lead')}</p>
      <div className="ob-permissions">
        {rows.map((permission) => row(permission, action(permission)))}
        {row(
          'files',
          <span className="ob-permission-note">
            {t('onboarding-permissions:files.note')}
          </span>
        )}
      </div>
      <div className="ob-actions">
        <button type="button" className="ob-primary" onClick={proceed}>
          {anyAllowed
            ? t('onboarding:continue')
            : t('onboarding-permissions:skip')}
          <ArrowRight size={17} aria-hidden="true" />
        </button>
      </div>

      <Dialog
        open={explainOpen}
        onOpenChange={(open) => {
          if (!open) notNow()
        }}
      >
        <DialogContent showCloseButton={false}>
          <ExplainIcon
            className="text-muted-foreground size-8"
            aria-hidden="true"
          />
          <DialogHeader>
            <DialogTitle>
              {t(`onboarding-permissions:${explaining}.ask`)}
            </DialogTitle>
            <DialogDescription>
              {t(`onboarding-permissions:${explaining}.detail`)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={notNow}>
              {t('onboarding-permissions:notNow')}
            </Button>
            <Button onClick={() => void request(explaining)}>
              {t('onboarding-permissions:allowAccess')}
              <Check aria-hidden="true" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={leaving !== null}
        onOpenChange={(open) => {
          if (!open) setLeaving(null)
        }}
      >
        <DialogContent showCloseButton={false}>
          <ShieldCheck
            className="text-muted-foreground size-8"
            aria-hidden="true"
          />
          <DialogHeader>
            <DialogTitle>
              {t('onboarding-permissions:warning.title')}
            </DialogTitle>
            <DialogDescription>
              {t('onboarding-permissions:warning.body')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLeaving(null)}>
              {t('onboarding-permissions:warning.review')}
            </Button>
            <Button onClick={leaveWithout}>
              {t('onboarding-permissions:warning.proceed')}
              <ArrowRight aria-hidden="true" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
