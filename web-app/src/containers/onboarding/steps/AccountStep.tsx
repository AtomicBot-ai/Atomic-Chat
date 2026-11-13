import { useEffect } from 'react'
import {
  ArrowRight,
  Check,
  Loader2,
  MessagesSquare,
  MonitorSmartphone,
  Smartphone,
} from 'lucide-react'

import { AccountAvatar } from '@/containers/account/AccountAvatar'
import { GoogleSignInButton } from '@/containers/account/GoogleSignInButton'
import {
  CODE_LENGTH,
  useAccountSignIn,
} from '@/containers/account/useAccountSignIn'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { accountLabel, formatCountdown } from '@/lib/account'
import { captureOnboardingEvent } from '@/lib/onboarding-telemetry'
import { useAccountStore } from '@/stores/account-store'

import type { StepProps } from './types'
import '../account.css'

const BENEFITS = [
  { key: 'sync', Icon: MessagesSquare },
  { key: 'remote', Icon: Smartphone },
  { key: 'everywhere', Icon: MonitorSmartphone },
] as const

/**
 * "One account. Every device.": what an Atomic Chat account adds (private
 * chat sync, remote access, one sign-in for every app), and signing in with
 * Google or an email code right here. Optional like the steps before it:
 * Skip goes on without an account. Shown where the accounts flag is on
 * (`accountAvailability`).
 */
export function AccountStep({ next }: StepProps) {
  const { t } = useTranslation()
  const status = useAccountStore((state) => state.status)
  const hydrate = useAccountStore((state) => state.hydrate)
  const setStatus = useAccountStore((state) => state.setStatus)

  // The rail that usually reads the status is not on screen during setup.
  useEffect(() => {
    void hydrate()
  }, [hydrate])

  const signIn = useAccountSignIn({
    onSignedIn: (signedIn, method) => {
      setStatus(signedIn)
      captureOnboardingEvent('onboarding_account_signed_in', { method })
    },
  })
  const user = status.signedIn ? status.user : null

  return (
    <>
      <h1 tabIndex={-1}>{t('onboarding-account:title')}</h1>
      <p className="ob-lead">{t('onboarding-account:lead')}</p>
      <ul className="ob-account-benefits">
        {BENEFITS.map(({ key, Icon }) => (
          <li key={key} className="ob-account-benefit">
            <Icon size={22} aria-hidden="true" />
            <h3>{t(`onboarding-account:${key}.title`)}</h3>
            <p>{t(`onboarding-account:${key}.reason`)}</p>
          </li>
        ))}
      </ul>

      {user ? (
        <div
          className="ob-account-ready"
          data-testid="onboarding-account-ready"
        >
          <AccountAvatar
            user={user}
            className="size-10"
            fallbackClassName="text-sm"
          />
          <span className="ob-account-who">
            <strong>{accountLabel(user)}</strong>
            <small>
              {user.displayName?.trim()
                ? user.email
                : t('onboarding-account:ready')}
            </small>
          </span>
          <span className="ob-granted">
            <Check size={14} aria-hidden="true" />
            {t('onboarding-account:signedIn')}
          </span>
        </div>
      ) : (
        <div
          className="ob-account-sign-in"
          data-testid="onboarding-account-sign-in"
        >
          {signIn.step === 'email' ? (
            <div className="ob-account-methods">
              {signIn.googleAvailable &&
                (signIn.busy === 'google' ? (
                  <div className="ob-account-waiting" role="status">
                    <Loader2 className="animate-spin" aria-hidden="true" />
                    <span>{t('account:signIn.googleWaiting')}</span>
                    <button
                      type="button"
                      className="ob-text"
                      onClick={signIn.cancelGoogle}
                    >
                      {t('account:signIn.cancel')}
                    </button>
                  </div>
                ) : (
                  <GoogleSignInButton
                    label={t('account:signIn.google')}
                    disabled={signIn.working}
                    onClick={() => void signIn.signInWithGoogle()}
                    className="h-auto min-h-[42px] w-auto pr-5 pl-[50px] text-[length:calc(var(--font-size-base)*0.8125)]"
                  />
                ))}
              {signIn.googleAvailable && (
                <span className="ob-account-or">{t('account:signIn.or')}</span>
              )}
              <form
                className="ob-account-field"
                onSubmit={signIn.sendCode}
                noValidate
              >
                <input
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  aria-label={t('account:signIn.emailLabel')}
                  aria-invalid={signIn.error !== null || undefined}
                  aria-describedby="ob-account-message"
                  placeholder={t('account:signIn.emailPlaceholder')}
                  value={signIn.email}
                  disabled={signIn.busy === 'google'}
                  onChange={(event) => signIn.editEmail(event.target.value)}
                />
                <button
                  type="submit"
                  className="ob-secondary"
                  disabled={signIn.working}
                >
                  {signIn.busy === 'send' && (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  )}
                  {t('account:signIn.sendCode')}
                </button>
              </form>
            </div>
          ) : (
            <form
              className="ob-account-code"
              onSubmit={signIn.submitCode}
              noValidate
            >
              <label htmlFor="ob-account-code">
                {t('account:signIn.codeSentTo', { email: signIn.email })}
              </label>
              <div className="ob-account-field">
                <input
                  id="ob-account-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  autoFocus
                  placeholder="000000"
                  aria-invalid={signIn.error !== null || undefined}
                  aria-describedby="ob-account-message"
                  value={signIn.code}
                  disabled={signIn.busy === 'verify'}
                  onChange={(event) => signIn.changeCode(event.target.value)}
                />
                <button
                  type="submit"
                  className="ob-secondary"
                  disabled={
                    signIn.working || signIn.code.length !== CODE_LENGTH
                  }
                >
                  {signIn.busy === 'verify' && (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  )}
                  {t('account:signIn.verify')}
                </button>
              </div>
              <div className="ob-account-links">
                <button
                  type="button"
                  className="ob-text"
                  disabled={signIn.working || signIn.resendLeft > 0}
                  onClick={() => void signIn.resend()}
                >
                  {signIn.resendLeft > 0
                    ? t('account:signIn.resendIn', {
                        time: formatCountdown(signIn.resendLeft),
                      })
                    : t('account:signIn.resend')}
                </button>
                <button
                  type="button"
                  className="ob-text"
                  disabled={signIn.working}
                  onClick={signIn.changeEmail}
                >
                  {t('account:signIn.differentEmail')}
                </button>
              </div>
            </form>
          )}
          {/* Always one line tall, so a message never moves the page. */}
          <small
            id="ob-account-message"
            className={signIn.error ? 'is-error' : undefined}
            role={signIn.error ? 'alert' : 'status'}
            aria-live="polite"
          >
            {signIn.error ?? signIn.notice ?? ' '}
          </small>
        </div>
      )}

      <div className="ob-actions">
        <button
          type="button"
          className="ob-primary"
          onClick={() => next(user ? 'continue' : 'skip')}
        >
          {user ? t('onboarding:continue') : t('onboarding-account:skip')}
          <ArrowRight size={17} aria-hidden="true" />
        </button>
      </div>
    </>
  )
}
