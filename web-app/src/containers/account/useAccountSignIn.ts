import { useEffect, useRef, useState, type FormEvent } from 'react'

import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { accountErrorMessage } from '@/lib/account'
import { toAccountError } from '@/services/account/errors'
import type { AccountStatus, EmailChallenge } from '@/services/account/types'

export const CODE_LENGTH = 6
// Loose on purpose: the backend has the final word (`invalid_request`).
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type SignInBusy = 'google' | 'send' | 'verify' | 'resend' | null
export type SignInMethod = 'google' | 'email'

/**
 * Signing in with Google or a one-time email code, without the markup: the
 * settings page (`AccountSignIn`) and the first-run account step draw it each
 * in their own style. `onSignedIn` gets the status the backend answered with
 * and the way the user signed in.
 */
export function useAccountSignIn({
  lockedEmail,
  onSignedIn,
}: {
  lockedEmail?: string
  onSignedIn: (status: AccountStatus, method: SignInMethod) => void
}) {
  const { t } = useTranslation()
  const account = useServiceHub().account()

  const [providers, setProviders] = useState<string[] | null>(null)
  const [email, setEmail] = useState(lockedEmail ?? '')
  const [challenge, setChallenge] = useState<EmailChallenge | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<SignInBusy>(null)
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
      if (mounted.current) onSignedIn(status, 'google')
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
      if (mounted.current) onSignedIn(status, 'email')
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

  const editEmail = (value: string) => {
    setEmail(value)
    if (error) setError(null)
  }

  const submitCode = (event: FormEvent) => {
    event.preventDefault()
    if (code.length === CODE_LENGTH && busy === null) void verify(code)
  }

  return {
    googleAvailable,
    step,
    email,
    editEmail,
    code,
    changeCode,
    busy,
    working: busy !== null,
    error,
    notice,
    resendLeft,
    signInWithGoogle,
    cancelGoogle,
    sendCode,
    submitCode,
    resend,
    changeEmail,
  }
}
