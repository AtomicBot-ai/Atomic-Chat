import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight } from 'lucide-react'

import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  captureOnboardingStepLeft,
  captureOnboardingStepShown,
  markOnboardingInFlight,
} from '@/lib/onboarding-telemetry'
import { handOffOnboarding } from '@/lib/onboarding/handoff'
import {
  getOnboardingVariant,
  nextStep,
  normalizeStep,
  prevStep,
  progressOf,
  resolveSteps,
  type OnboardingStepId,
} from '@/lib/onboarding/steps'
import { cn } from '@/lib/utils'
import {
  useOnboardingStore,
  type OnboardingDestination,
} from '@/stores/onboarding-store'

import { DownloadStrip } from './DownloadStrip'
import { BackendStep } from './steps/BackendStep'
import { CloudStep } from './steps/CloudStep'
import { MediaStep } from './steps/MediaStep'
import { ModelStep } from './steps/ModelStep'
import { PermissionsStep } from './steps/PermissionsStep'
import { PurposeStep } from './steps/PurposeStep'
import { ServerStep } from './steps/ServerStep'
import { WelcomeStep } from './steps/WelcomeStep'
import type { StepProps } from './steps/types'
import { useStepContext } from './useStepContext'
import './onboarding.css'

/**
 * What the shell hands a step screen beyond `StepProps`: a step can hold
 * "Skip setup" for a word of its own first, as the permissions step does
 * before leaving with nothing allowed. The guard returns true when it takes
 * over; the step then hands off itself if the user goes on.
 */
type StepScreenProps = StepProps & {
  guardSkipSetup: (guard: (() => boolean) | null) => void
}

/** The screen each step draws. */
const STEP_COMPONENTS: Record<
  OnboardingStepId,
  (props: StepScreenProps) => React.ReactNode
> = {
  welcome: WelcomeStep,
  backend: BackendStep,
  model: ModelStep,
  permissions: PermissionsStep,
  cloud: CloudStep,
  media: MediaStep,
  purpose: PurposeStep,
  server: ServerStep,
}

const twoDigits = (value: number) => String(value).padStart(2, '0')

/**
 * The first-run flow, full window: one step at a time, Back and Skip setup
 * underneath, the run's download above every step after Welcome. Which steps
 * there are comes from `lib/onboarding/steps`; where the run stands survives
 * a relaunch (`stores/onboarding-store`). Every way out goes through
 * `handOffOnboarding`.
 */
export function Onboarding() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const context = useStepContext()
  const variant = useOnboardingStore((state) => state.variant)
  const savedStep = useOnboardingStore((state) => state.step)
  const phase = useOnboardingStore((state) => state.phase)
  const steps = useMemo(
    () => resolveSteps(variant, context),
    // The context is rebuilt every render; its values are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [variant, ...Object.values(context)]
  )
  const step = normalizeStep(variant, steps, savedStep)

  // A fresh run starts here; a run that handed off and came back through
  // "Back to setup" is active again.
  useEffect(() => {
    const store = useOnboardingStore.getState()
    if (store.phase === 'idle') {
      store.begin(getOnboardingVariant(), steps[0]?.id ?? 'welcome')
    } else if (store.phase === 'handedOff') {
      store.reopen()
    }
    // Once, on entering the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the saved step on one the machine still shows.
  useEffect(() => {
    if (phase === 'active' && step && step !== savedStep) {
      useOnboardingStore.getState().goTo(step)
    }
  }, [phase, step, savedStep])

  // Per-step funnel: shown on arrival, left with the action that left it.
  const shownAtRef = useRef(Date.now())
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!step || phase !== 'active') return
    shownAtRef.current = Date.now()
    const progress = steps.findIndex((candidate) => candidate.id === step)
    captureOnboardingStepShown({
      step,
      stepIndex: progress + 1,
      stepCount: steps.length,
      variant,
    })
    markOnboardingInFlight(
      step,
      useOnboardingStore.getState().startedAt ?? Date.now()
    )
    contentRef.current?.querySelector<HTMLElement>('h1')?.focus()
    // Reported once per step change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, phase])

  const leaveStep = useCallback(
    (action: string) => {
      if (!step) return
      captureOnboardingStepLeft({
        step,
        action,
        durationMs: Date.now() - shownAtRef.current,
        variant,
      })
    },
    [step, variant]
  )

  const handOff = useCallback(
    (destination: OnboardingDestination, action = 'handoff') => {
      if (!step) return
      leaveStep(action)
      handOffOnboarding({ destination, stepReached: step, navigate })
    },
    [leaveStep, navigate, step]
  )

  const next = useCallback(
    (action = 'next') => {
      if (!step) return
      const target = nextStep(steps, step)
      if (!target) {
        handOff('chat', action)
        return
      }
      leaveStep(action)
      useOnboardingStore.getState().goTo(target)
    },
    [handOff, leaveStep, step, steps]
  )

  const goTo = useCallback(
    (target: OnboardingStepId, action = 'go_to') => {
      if (!step) return
      leaveStep(action)
      useOnboardingStore.getState().goTo(target)
    },
    [leaveStep, step]
  )

  const skipGuardRef = useRef<(() => boolean) | null>(null)
  const guardSkipSetup = useCallback((guard: (() => boolean) | null) => {
    skipGuardRef.current = guard
  }, [])

  if (!step) return null
  const StepScreen = STEP_COMPONENTS[step]
  const back = prevStep(steps, step)
  const progress = step === 'welcome' ? null : progressOf(steps, step)

  return (
    <div
      className={cn('ob-shell', IS_MACOS && 'ob-shell-titlebar')}
      data-testid="onboarding"
    >
      {/* macOS paints the traffic lights into the window (`titleBarStyle:
          "Overlay"`); without the app's title bar this strip is what drags
          the window, as `WindowTitlebar` is elsewhere. */}
      {IS_MACOS && <div className="ob-titlebar" data-tauri-drag-region />}
      <main className="ob-main">
        {step !== 'welcome' && <DownloadStrip />}
        <div
          ref={contentRef}
          className={cn('ob-content', step === 'welcome' && 'ob-welcome')}
        >
          {progress && (
            <div className="ob-eyebrow">
              {t('onboarding:stepOf', {
                index: twoDigits(progress.index),
                count: twoDigits(progress.count),
              })}
            </div>
          )}
          <StepScreen
            next={next}
            goTo={goTo}
            handOff={handOff}
            guardSkipSetup={guardSkipSetup}
          />
        </div>
        <footer className="ob-footer">
          <div className="ob-footer-row">
            {back ? (
              <button
                type="button"
                className="ob-text"
                onClick={() => goTo(back, 'back')}
              >
                <ArrowLeft size={15} aria-hidden="true" />
                {t('onboarding:back')}
              </button>
            ) : (
              <span />
            )}
            {step !== 'backend' && (
              <button
                type="button"
                className="ob-text"
                data-testid="onboarding-skip"
                onClick={() => {
                  if (skipGuardRef.current?.()) return
                  handOff('chat', 'skip_setup')
                }}
              >
                {t('onboarding:skipSetup')}
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            )}
          </div>
        </footer>
      </main>
    </div>
  )
}
