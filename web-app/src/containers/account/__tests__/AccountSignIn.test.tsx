import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TranslationContext } from '@/i18n/context'
import i18n from '@/i18n/setup'
import type { AccountService, AccountStatus } from '@/services/account/types'
import { seedServiceHub } from '@/test/service-hub'
import { AccountSignIn } from '../AccountSignIn'

const ada = {
  id: 'u1',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  avatarUrl: null,
}
const signedIn: AccountStatus = { signedIn: true, user: ada }

const accountError = (
  code: string,
  extra: { attemptsLeft?: number; retryAfter?: number } = {}
) => ({
  code,
  message: code,
  attemptsLeft: extra.attemptsLeft ?? null,
  retryAfter: extra.retryAfter ?? null,
})

function mockAccount(providers = ['email', 'google']) {
  return {
    providers: vi.fn(async () => providers),
    emailStart: vi.fn(async () => ({
      challengeId: 'ch1',
      expiresIn: 600,
      resendIn: 30,
    })),
    emailVerify: vi.fn(async () => signedIn),
    googleLogin: vi.fn(async () => signedIn),
    cancelLogin: vi.fn(async () => {}),
  }
}

let account: ReturnType<typeof mockAccount>

/** Real English copy, so assertions read what the user reads. */
async function renderSignIn(props: { lockedEmail?: string } = {}) {
  const onSignedIn = vi.fn()
  // Inside act, so the provider list has landed before the test goes on.
  await act(async () => {
    render(
      <TranslationContext.Provider value={{ t: i18n.t, i18n }}>
        <AccountSignIn onSignedIn={onSignedIn} {...props} />
      </TranslationContext.Provider>
    )
    // One macrotask, so the async effects' answers land inside act too.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { onSignedIn }
}

async function reachCodeStep(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), 'ada@example.com')
  await user.click(screen.getByRole('button', { name: 'Send code' }))
  return screen.findByLabelText('Code')
}

beforeEach(() => {
  account = mockAccount()
  seedServiceHub({ account: account as unknown as AccountService })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AccountSignIn', () => {
  it('sends a code by email and signs in once six digits are typed', async () => {
    const user = userEvent.setup()
    const { onSignedIn } = await renderSignIn()

    const code = await reachCodeStep(user)
    expect(account.emailStart).toHaveBeenCalledWith('ada@example.com')
    expect(
      screen.getByText('Enter the 6-digit code we sent to ada@example.com.')
    ).toBeInTheDocument()
    expect(code).toHaveAttribute('inputmode', 'numeric')
    expect(code).toHaveAttribute('autocomplete', 'one-time-code')

    await user.type(code, '123456')

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(signedIn))
    expect(account.emailVerify).toHaveBeenCalledTimes(1)
    expect(account.emailVerify).toHaveBeenCalledWith('ch1', '123456')
  })

  it('takes a pasted code with spaces and submits it', async () => {
    const user = userEvent.setup()
    const { onSignedIn } = await renderSignIn()

    const code = await reachCodeStep(user)
    await user.click(code)
    await user.paste('123 456')

    // The space is dropped from what the field shows, not just from what is sent.
    expect(code).toHaveValue('123456')
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled())
    expect(account.emailVerify).toHaveBeenCalledWith('ch1', '123456')
  })

  it('says how many attempts a wrong code leaves', async () => {
    account.emailVerify
      .mockRejectedValueOnce(accountError('invalid_code', { attemptsLeft: 2 }))
      .mockRejectedValueOnce(accountError('invalid_code', { attemptsLeft: 1 }))
    const user = userEvent.setup()
    const { onSignedIn } = await renderSignIn()

    const code = await reachCodeStep(user)
    await user.type(code, '111111')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Wrong code, 2 attempts left.'
    )
    expect(code).toHaveValue('')

    await user.type(code, '222222')
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Wrong code, 1 attempt left.'
      )
    )
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('goes back to the email step after too many wrong codes', async () => {
    account.emailVerify.mockRejectedValueOnce(accountError('too_many_attempts'))
    const user = userEvent.setup()
    await renderSignIn()

    await user.type(await reachCodeStep(user), '111111')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many wrong codes. Request a new one.'
    )
    expect(screen.getByLabelText('Email')).toHaveValue('ada@example.com')
    expect(screen.queryByLabelText('Code')).not.toBeInTheDocument()
  })

  it('counts down before a code can be resent', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const user = userEvent.setup()
    await renderSignIn()

    await reachCodeStep(user)
    const resend = screen.getByTestId('account-resend')
    expect(resend).toHaveTextContent('Resend code in 0:30')
    expect(resend).toBeDisabled()

    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(resend).toHaveTextContent('Resend code in 0:20')

    act(() => {
      vi.advanceTimersByTime(20_000)
    })
    expect(resend).toHaveTextContent(/^Resend code$/)
    expect(resend).toBeEnabled()

    await user.click(resend)
    await waitFor(() => expect(account.emailStart).toHaveBeenCalledTimes(2))
    expect(account.emailStart).toHaveBeenLastCalledWith('ada@example.com')
    expect(await screen.findByRole('status')).toHaveTextContent(
      'We sent you a new code.'
    )
    expect(resend).toHaveTextContent('Resend code in 0:30')
  })

  it('waits out rate limiting before resending', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    account.emailStart
      .mockResolvedValueOnce({
        challengeId: 'ch1',
        expiresIn: 600,
        resendIn: 0,
      })
      .mockRejectedValueOnce(accountError('rate_limited', { retryAfter: 45 }))
    const user = userEvent.setup()
    await renderSignIn()

    await reachCodeStep(user)
    await user.click(screen.getByTestId('account-resend'))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Try again in 45 seconds.'
    )
    expect(screen.getByTestId('account-resend')).toHaveTextContent(
      'Resend code in 0:45'
    )
  })

  it('rejects an address that is not an email before calling the backend', async () => {
    const user = userEvent.setup()
    await renderSignIn()

    await user.type(screen.getByLabelText('Email'), 'ada')
    await user.click(screen.getByRole('button', { name: 'Send code' }))

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter a valid email address.'
    )
    expect(account.emailStart).not.toHaveBeenCalled()
  })

  it('hides Continue with Google when the backend does not offer it', async () => {
    account = mockAccount(['email'])
    seedServiceHub({ account: account as unknown as AccountService })
    await renderSignIn()

    expect(account.providers).toHaveBeenCalled()
    expect(
      screen.queryByRole('button', { name: 'Continue with Google' })
    ).not.toBeInTheDocument()
    expect(screen.queryByText('or')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
  })

  it('keeps Continue with Google when the provider list cannot be loaded', async () => {
    account = mockAccount()
    account.providers.mockRejectedValueOnce({
      code: 'network',
      message: 'offline',
      attemptsLeft: null,
      retryAfter: null,
    })
    seedServiceHub({ account: account as unknown as AccountService })
    await renderSignIn()

    expect(
      screen.getByRole('button', { name: 'Continue with Google' })
    ).toBeEnabled()
    expect(screen.getByText('or')).toBeInTheDocument()
  })

  it('signs in with Google and lets a pending attempt be cancelled quietly', async () => {
    let reject: (reason: unknown) => void = () => {}
    account.googleLogin.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail
        })
    )
    account.cancelLogin.mockImplementationOnce(async () =>
      reject(accountError('cancelled'))
    )
    const user = userEvent.setup()
    const { onSignedIn } = await renderSignIn()

    await user.click(
      await screen.findByRole('button', { name: 'Continue with Google' })
    )
    expect(
      screen.getByText('Finish signing in in your browser')
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(account.cancelLogin).toHaveBeenCalledTimes(1)
    expect(
      await screen.findByRole('button', { name: 'Continue with Google' })
    ).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onSignedIn).not.toHaveBeenCalled()

    await user.click(
      screen.getByRole('button', { name: 'Continue with Google' })
    )
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(signedIn))
  })

  it('keeps a locked email read-only and offers no other address', async () => {
    const user = userEvent.setup()
    await renderSignIn({ lockedEmail: 'ada@example.com' })

    const email = screen.getByLabelText('Email')
    expect(email).toHaveValue('ada@example.com')
    expect(email).toHaveAttribute('readonly')

    await user.click(screen.getByRole('button', { name: 'Send code' }))
    await screen.findByLabelText('Code')
    expect(account.emailStart).toHaveBeenCalledWith('ada@example.com')
    expect(
      screen.queryByRole('button', { name: 'Use a different email' })
    ).not.toBeInTheDocument()
  })
})
