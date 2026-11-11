import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { CardItem } from '@/containers/Card'
import { Input } from '@/components/ui/input'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { accountErrorMessage, formatCountdown } from '@/lib/account'
import { cn } from '@/lib/utils'
import { toAccountError } from '@/services/account/errors'
import type { AccountStatus, EmailChallenge } from '@/services/account/types'
import { GoogleSignInButton } from './GoogleSignInButton'

const CODE_LENGTH = 6
// Loose on purpose: the backend has the final word (`invalid_request`).
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type Busy = 'google' | 'send' | 'verify' | 'resend' | null

/**
 * Signing in with Google or a one-time email code. Also the re-auth step of
 * account deletion: `lockedEmail` fixes the address, and `onSignedIn` gets the
 * status the backend answered with, so the caller can check who signed in.
 *
 * `rows` lays it out like every other settings card (label left, control
 * right); `stacked` is the narrow column the delete dialog uses.
 */
export function AccountSignIn({
  lockedEmail,
  onSignedIn,
  variant = 'stacked',
  className,
}: {
  lockedEmail?: string
  onSignedIn: (status: AccountStatus) => void
  variant?: 'stacked' | 'rows'
  className?: string
}) {
  const { t } = useTranslation()
  const account = useServiceHub().account()

  const [providers, setProviders] = useState<string[] | null>(null)
  const [email, setEmail] = useState(lockedEmail ?? '')
  const [challenge, setChallenge] = useState<EmailChallenge | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [resendAt, setResendAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  const mounted = useRef(true)
  const googlePending = useRef(false)

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    account
      .providers()
      .then((list) => !cancelled && setProviders(list))
      // Without the list, keep offering both: Google is hidden only when the
      // backend says it is off, never over a slow or failed request.
      .catch(() => {})
    return () => {
      cancelled = true
      mounted.current = false
      // Leaving mid-Google (page change, dialog closed) ends that attempt.
      if (googlePending.current) void account.cancelLogin().catch(() => {})
    }
  }, [account])

  // Ticks only while a resend countdown is running.
  useEffect(() => {
    if (resendAt <= Date.now()) return
    const timer = window.setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= resendAt) window.clearInterval(timer)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [resendAt])

  const startCountdown = (seconds: number) => {
    const current = Date.now()
    setNow(current)
    setResendAt(current + Math.max(0, seconds) * 1000)
  }

  const resendLeft = Math.max(0, Math.ceil((resendAt - now) / 1000))
  const googleAvailable = providers === null || providers.includes('google')
  const step = challenge ? 'code' : 'email'

  const fail = (raw: unknown, overrides?: Record<string, string>) => {
    const accountError = toAccountError(raw)
    setError(accountErrorMessage(t, accountError, overrides))
    return accountError
  }

  const signInWithGoogle = async () => {
    setBusy('google')
    setError(null)
    setNotice(null)
    googlePending.current = true
    try {
      const status = await account.googleLogin()
      googlePending.current = false
      if (mounted.current) onSignedIn(status)
    } catch (raw) {
      googlePending.current = false
      if (mounted.current) fail(raw)
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  const cancelGoogle = () => {
    // The pending login rejects with `cancelled`, which says nothing.
    void account.cancelLogin().catch(() => {})
  }

  const sendCode = async (event?: FormEvent) => {
    event?.preventDefault()
    const address = email.trim()
    if (!EMAIL_PATTERN.test(address)) {
      setError(t('account:errors.invalidEmail'))
      return
    }
    setBusy('send')
    setError(null)
    setNotice(null)
    try {
      const next = await account.emailStart(address)
      if (!mounted.current) return
      setEmail(address)
      setChallenge(next)
      setCode('')
      startCountdown(next.resendIn)
    } catch (raw) {
      if (mounted.current)
        fail(raw, { invalid_request: 'account:errors.invalidEmail' })
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  const resend = async () => {
    setBusy('resend')
    setError(null)
    setNotice(null)
    try {
      const next = await account.emailStart(email)
      if (!mounted.current) return
      setChallenge(next)
      setCode('')
      startCountdown(next.resendIn)
      setNotice(t('account:signIn.codeResent'))
    } catch (raw) {
      if (!mounted.current) return
      const accountError = fail(raw)
      if (accountError.code === 'rate_limited' && accountError.retryAfter)
        startCountdown(accountError.retryAfter)
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  const verify = async (value: string) => {
    if (!challenge) return
    setBusy('verify')
    setError(null)
    setNotice(null)
    try {
      const status = await account.emailVerify(challenge.challengeId, value)
      if (mounted.current) onSignedIn(status)
    } catch (raw) {
      if (!mounted.current) return
      const accountError = fail(raw)
      setCode('')
      if (accountError.code === 'too_many_attempts') {
        // This challenge is spent: start over from the address.
        setChallenge(null)
      } else if (
        accountError.code === 'code_expired' ||
        accountError.code === 'invalid_challenge'
      ) {
        // A new code is the only way on; don't make them wait for it.
        setResendAt(0)
      }
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  const changeCode = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, CODE_LENGTH)
    setCode(digits)
    if (digits.length === CODE_LENGTH && busy === null) void verify(digits)
  }

  const changeEmail = () => {
    setChallenge(null)
    setCode('')
    setError(null)
    setNotice(null)
    setResendAt(0)
  }

  const working = busy !== null
  const rows = variant === 'rows'

  const googleControl =
    busy === 'google' ? (
      <div
        className={cn(
          'flex h-[var(--control-height-large,2rem)] min-w-0 items-center gap-2 rounded-full border border-border px-3',
          rows && 'max-w-72'
        )}
        role="status"
      >
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {t('account:signIn.googleWaiting')}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0"
          onClick={cancelGoogle}
        >
          {t('account:signIn.cancel')}
        </Button>
      </div>
    ) : (
      <GoogleSignInButton
        label={t('account:signIn.google')}
        disabled={working}
        onClick={() => void signInWithGoogle()}
        className={rows ? 'w-auto pr-4 pl-11' : undefined}
      />
    )

  const emailField = (
    <Input
      id={rows ? undefined : 'account-email'}
      aria-label={rows ? t('account:signIn.emailLabel') : undefined}
      type="email"
      inputMode="email"
      autoComplete="email"
      placeholder={t('account:signIn.emailPlaceholder')}
      value={email}
      readOnly={lockedEmail !== undefined}
      aria-invalid={error !== null || undefined}
      className={rows ? 'w-56' : undefined}
      onChange={(event) => {
        setEmail(event.target.value)
        if (error) setError(null)
      }}
      disabled={busy === 'google'}
    />
  )

  const sendButton = (
    <Button
      type="submit"
      size="sm"
      className="min-w-24 shrink-0"
      disabled={working}
    >
      {busy === 'send' && <Loader2 className="animate-spin" />}
      {t('account:signIn.sendCode')}
    </Button>
  )

  const codeField = (
    <Input
      id={rows ? undefined : 'account-code'}
      aria-label={rows ? t('account:signIn.codeLabel') : undefined}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      autoFocus
      value={code}
      aria-invalid={error !== null || undefined}
      placeholder="000000"
      className={cn('font-mono tracking-[0.3em] tabular-nums', rows && 'w-36')}
      onChange={(event) => changeCode(event.target.value)}
      disabled={busy === 'verify'}
    />
  )

  const verifyButton = (
    <Button
      type="submit"
      size="sm"
      className="min-w-24 shrink-0"
      disabled={working || code.length !== CODE_LENGTH}
    >
      {busy === 'verify' && <Loader2 className="animate-spin" />}
      {t('account:signIn.verify')}
    </Button>
  )

  const codeLinks = (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <Button
        type="button"
        variant="link"
        size="xs"
        className="px-0 tabular-nums"
        disabled={working || resendLeft > 0}
        onClick={() => void resend()}
        data-testid="account-resend"
      >
        {resendLeft > 0
          ? t('account:signIn.resendIn', {
              time: formatCountdown(resendLeft),
            })
          : t('account:signIn.resend')}
      </Button>
      {lockedEmail === undefined && (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="px-0"
          disabled={working}
          onClick={changeEmail}
        >
          {t('account:signIn.differentEmail')}
        </Button>
      )}
    </span>
  )

  const submitCode = (event: FormEvent) => {
    event.preventDefault()
    if (code.length === CODE_LENGTH && !working) void verify(code)
  }

  const message = (error || notice) && (
    <p
      role={error ? 'alert' : 'status'}
      className={cn(
        'text-sm break-words',
        error ? 'text-destructive' : 'text-muted-foreground'
      )}
    >
      {error ?? notice}
    </p>
  )

  if (rows) {
    return (
      <div className={cn('min-w-0', className)} data-testid="account-sign-in">
        {step === 'email' && googleAvailable && (
          <CardItem
            title={t('account:signIn.googleRowTitle')}
            description={t('account:signIn.googleRowDesc')}
            actions={googleControl}
          />
        )}
        {step === 'email' && (
          <CardItem
            title={
              googleAvailable
                ? t('account:signIn.emailRowTitle')
                : t('account:signIn.googleRowTitle')
            }
            description={t('account:signIn.emailRowDesc')}
            actions={
              <form
                className="flex items-center gap-2"
                onSubmit={sendCode}
                noValidate
              >
                {emailField}
                {sendButton}
              </form>
            }
          />
        )}
        {step === 'code' && (
          <CardItem
            align="start"
            title={t('account:signIn.codeLabel')}
            description={
              <span className="flex flex-col items-start gap-1">
                <span className="break-words">
                  {t('account:signIn.codeSentTo', { email })}
                </span>
                {codeLinks}
              </span>
            }
            actions={
              <form
                className="flex items-center gap-2"
                onSubmit={submitCode}
                noValidate
              >
                {codeField}
                {verifyButton}
              </form>
            }
          />
        )}
        {message && <div className="mt-3">{message}</div>}
      </div>
    )
  }

  return (
    <div
      className={cn('flex w-full max-w-sm flex-col gap-3', className)}
      data-testid="account-sign-in"
    >
      {step === 'email' && (
        <>
          {googleAvailable && googleControl}

          {googleAvailable && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              {t('account:signIn.or')}
              <span className="h-px flex-1 bg-border" />
            </div>
          )}

          <form className="flex flex-col gap-2" onSubmit={sendCode} noValidate>
            <label
              htmlFor="account-email"
              className="text-sm font-medium text-foreground"
            >
              {t('account:signIn.emailLabel')}
            </label>
            <div className="flex min-w-0 items-center gap-2">
              {emailField}
              {sendButton}
            </div>
          </form>
        </>
      )}

      {step === 'code' && (
        <form className="flex flex-col gap-2" onSubmit={submitCode} noValidate>
          <label
            htmlFor="account-code"
            className="text-sm font-medium text-foreground"
          >
            {t('account:signIn.codeLabel')}
          </label>
          <p className="text-sm text-muted-foreground break-words">
            {t('account:signIn.codeSentTo', { email })}
          </p>
          <div className="flex min-w-0 items-center gap-2">
            {codeField}
            {verifyButton}
          </div>
          {codeLinks}
        </form>
      )}

      {message}
    </div>
  )
}
