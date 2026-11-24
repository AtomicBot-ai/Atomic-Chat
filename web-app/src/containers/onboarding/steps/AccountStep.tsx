import { useEffect, useState } from 'react'
import {
  ArrowRight,
  Check,
  Loader2,
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
  const [enterEmail, setEnterEmail] = useState(false)
  const user = status.signedIn ? status.user : null

  return (
    <div className="ob-account-layout">
      <section className="ob-account-panel">
        <h1 tabIndex={-1}>
          {user
            ? t('onboarding-account:signedIn')
            : t('onboarding-account:title')}
        </h1>
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
            {signIn.step === 'email' && !enterEmail ? (
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
                      className="h-auto min-h-[max(44px,calc(var(--font-size-base)*2.5))] w-full px-[44px] text-[length:calc(var(--font-size-base)*0.8125)]"
                    />
                  ))}
                <button
                  type="button"
                  className="ob-secondary ob-account-email-choice"
                  disabled={signIn.working}
                  onClick={() => {
                    signIn.changeEmail()
                    setEnterEmail(true)
                  }}
                >
                  {t('onboarding-account:emailMethod')}
                </button>
              </div>
            ) : signIn.step === 'email' ? (
              <form
                className="ob-account-field ob-account-email-form"
                onSubmit={signIn.sendCode}
                noValidate
              >
                <label htmlFor="ob-account-email">
                  {t('account:signIn.emailLabel')}
                </label>
                <input
                  id="ob-account-email"
                  autoFocus
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
                  className="ob-primary"
                  disabled={signIn.working}
                >
                  {signIn.busy === 'send' && (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  )}
                  {t('account:signIn.sendCode')}
                </button>
              </form>
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
                    className="ob-primary"
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
            className={user ? 'ob-primary' : 'ob-text'}
            onClick={() => next(user ? 'continue' : 'skip')}
          >
            {user ? t('onboarding:continue') : t('onboarding-account:skip')}
            {user && <ArrowRight size={17} aria-hidden="true" />}
          </button>
        </div>
      </section>
      {(
        [
          { key: 'remote', Icon: Smartphone },
          { key: 'everywhere', Icon: MonitorSmartphone },
        ] as const
      ).map(({ key, Icon }) => (
        <aside key={key} className={`ob-account-note ob-account-${key}`}>
          <Icon size={22} aria-hidden="true" />
          <h2>{t(`onboarding-account:${key}.title`)}</h2>
          <p>{t(`onboarding-account:${key}.reason`)}</p>
        </aside>
      ))}
    </div>
  )
}
