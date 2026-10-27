import { useState } from 'react'
import { ArrowRight, Check } from 'lucide-react'

import { useModelProvider } from '@/hooks/useModelProvider'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { captureOnboardingEvent } from '@/lib/onboarding-telemetry'
import { findChatModel } from '@/lib/onboarding/jobs'
import { useOnboardingStore } from '@/stores/onboarding-store'

import { AtomicMines } from './AtomicMines'
import type { StepProps } from './types'
import { EMAIL_REMINDER_OFFERED } from './waitAvailability'
import '../wait.css'

/**
 * "Good things are downloading.": the last screen of everyday use while the
 * model downloads (`waitsForChatModel`), with the download strip above it
 * (`Onboarding`). The app is open to explore meanwhile; Atomic Mines passes
 * the time; an email can be left for a reminder. Once the model is ready the
 * screen says so and offers the chat.
 *
 * The reminder is the prototype's: the address is neither kept nor sent yet
 * (ADR 2026-10-26-show-a-wait-screen-while-the-first-model-downloads), only
 * that one was asked for is reported, so the form stays hidden until it is
 * delivered (`EMAIL_REMINDER_OFFERED`).
 */
export function WaitStep({ handOff }: StepProps) {
  const { t } = useTranslation()
  const choice = useOnboardingStore((state) => state.choice)
  const providers = useModelProvider((state) => state.providers)
  const ready = findChatModel(choice, providers) !== null

  const [showGame, setShowGame] = useState(false)
  const [email, setEmail] = useState('')
  const [reminderSet, setReminderSet] = useState(false)

  const toggleGame = () => {
    if (!showGame) captureOnboardingEvent('onboarding_wait_game', {})
    setShowGame((shown) => !shown)
  }

  return (
    <>
      <h1 tabIndex={-1}>
        {ready ? t('onboarding-wait:readyTitle') : t('onboarding-wait:title')}
      </h1>
      <p className="ob-lead">
        {ready ? t('onboarding-wait:readyLead') : t('onboarding-wait:lead')}
      </p>
      <div className="ob-actions ob-wait-actions">
        <button
          type="button"
          className="ob-primary"
          onClick={() => handOff('chat', ready ? 'start_chatting' : 'explore')}
        >
          {ready
            ? t('onboarding-wait:startChatting')
            : t('onboarding-wait:explore')}
          <ArrowRight size={17} aria-hidden="true" />
        </button>
        {!ready && (
          <button
            type="button"
            className="ob-secondary"
            aria-expanded={showGame}
            onClick={toggleGame}
          >
            {showGame
              ? t('onboarding-wait:hideGame')
              : t('onboarding-wait:playGame')}
          </button>
        )}
      </div>
      {!ready && EMAIL_REMINDER_OFFERED && (
        <form
          className="ob-email"
          onSubmit={(event) => {
            event.preventDefault()
            if (!email.trim()) return
            captureOnboardingEvent('onboarding_reminder_requested', {})
            setReminderSet(true)
            setEmail('')
          }}
        >
          <label htmlFor="ob-email">{t('onboarding-wait:email.label')}</label>
          <p>{t('onboarding-wait:email.hint')}</p>
          <div>
            <input
              id="ob-email"
              type="email"
              required
              autoComplete="email"
              placeholder={t('onboarding-wait:email.placeholder')}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                setReminderSet(false)
              }}
            />
            <button type="submit" className="ob-secondary">
              {t('onboarding-wait:email.submit')}
            </button>
          </div>
          {reminderSet && (
            <small role="status">{t('onboarding-wait:email.done')}</small>
          )}
        </form>
      )}
      {/* A game under way stays when the model turns ready. */}
      {showGame && <AtomicMines />}
      {ready && (
        <div className="ob-ready">
          <Check size={24} aria-hidden="true" />
          <span>
            {choice?.title}
            <small>{t('onboarding-wait:readyOnDevice')}</small>
          </span>
        </div>
      )}
    </>
  )
}
