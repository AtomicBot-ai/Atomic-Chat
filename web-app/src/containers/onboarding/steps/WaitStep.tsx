import { useRef, useState } from 'react'
import { ArrowRight, Check } from 'lucide-react'

import { useModelProvider } from '@/hooks/useModelProvider'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { captureOnboardingEvent } from '@/lib/onboarding-telemetry'
import { findChatModel } from '@/lib/onboarding/jobs'
import { useOnboardingStore } from '@/stores/onboarding-store'
import {
  requestEmailReminder,
  useEmailReminderStore,
} from '@/stores/email-reminder-store'
import { EmailReminderError } from '@/services/email-reminders'

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
 * A success means the API accepted the address. The global runtime reports
 * readiness later; the email itself stays out of local storage and telemetry.
 */
export function WaitStep({ handOff }: StepProps) {
  const { t, i18n } = useTranslation()
  const choice = useOnboardingStore((state) => state.choice)
  const providers = useModelProvider((state) => state.providers)
  const ready = findChatModel(choice, providers) !== null

  const [showGame, setShowGame] = useState(false)
  const [email, setEmail] = useState('')
  const reminder = useEmailReminderStore((state) => state.reminder)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const reminderSet =
    !email &&
    reminder?.provider === choice?.provider &&
    reminder?.matchIds.some((id) => choice?.matchIds.includes(id)) &&
    (reminder?.status === 'waiting' || reminder?.status === 'queued')

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
          onSubmit={async (event) => {
            event.preventDefault()
            if (!email.trim() || !choice || submittingRef.current) return
            submittingRef.current = true
            setSubmitting(true)
            setError(null)
            try {
              await requestEmailReminder(email, i18n?.language ?? 'en', choice)
              captureOnboardingEvent('onboarding_reminder_requested', {})
              setEmail('')
            } catch (cause) {
              setError(
                cause instanceof EmailReminderError && cause.status === 429
                  ? 'rateLimited'
                  : cause instanceof EmailReminderError && cause.status === 422
                    ? 'invalid'
                    : 'error'
              )
            } finally {
              submittingRef.current = false
              setSubmitting(false)
            }
          }}
        >
          <label htmlFor="ob-email">{t('onboarding-wait:email.label')}</label>
          <p id="ob-email-hint">{t('onboarding-wait:email.hint')}</p>
          <div>
            <input
              id="ob-email"
              type="email"
              required
              maxLength={320}
              disabled={submitting}
              aria-describedby="ob-email-hint ob-email-status"
              aria-invalid={error === 'invalid' || undefined}
              autoComplete="email"
              placeholder={t('onboarding-wait:email.placeholder')}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                setError(null)
              }}
            />
            <button
              type="submit"
              className="ob-secondary"
              disabled={submitting || !email.trim()}
            >
              {t('onboarding-wait:email.submit')}
            </button>
          </div>
          <small id="ob-email-status" role="status" aria-live="polite">
            {submitting
              ? t('onboarding-wait:email.saving')
              : error
                ? t(`onboarding-wait:email.${error}`)
                : reminderSet
                  ? t('onboarding-wait:email.done')
                  : '\u00a0'}
          </small>
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
