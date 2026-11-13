import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TranslationContext } from '@/i18n/context'
import i18n from '@/i18n/setup'
import type { AccountService, AccountStatus } from '@/services/account/types'
import { resetAccountStore } from '@/stores/account-store'
import { seedServiceHub } from '@/test/service-hub'

const telemetry = vi.hoisted(() => ({ capture: vi.fn() }))
vi.mock('@/lib/onboarding-telemetry', () => ({
  captureOnboardingEvent: telemetry.capture,
}))

import { AccountStep } from '../steps/AccountStep'

const ada = {
  id: 'u1',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  avatarUrl: null,
}
const signedIn: AccountStatus = { signedIn: true, user: ada }
const signedOut: AccountStatus = { signedIn: false, user: null }

function mockAccount(status: AccountStatus) {
  return {
    status: vi.fn(async () => status),
    onChanged: vi.fn(async () => () => {}),
    providers: vi.fn(async () => ['email', 'google']),
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
async function renderStep(status: AccountStatus = signedOut) {
  account = mockAccount(status)
  seedServiceHub({ account: account as unknown as AccountService })
  const next = vi.fn()
  await act(async () => {
    render(
      <TranslationContext.Provider value={{ t: i18n.t, i18n }}>
        <AccountStep next={next} goTo={vi.fn()} handOff={vi.fn()} />
      </TranslationContext.Provider>
    )
    // One macrotask, so the async effects' answers land inside act too.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { next }
}

beforeEach(() => {
  resetAccountStore()
  telemetry.capture.mockClear()
})

describe('AccountStep', () => {
  it('says what an account adds and goes on without one', async () => {
    const user = userEvent.setup()
    const { next } = await renderStep()

    expect(
      screen.getByRole('heading', { name: 'One account. Every device.' })
    ).toBeInTheDocument()
    for (const title of [
      'Private chat sync',
      'Remote access',
      'One sign-in everywhere',
    ]) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
    }
    expect(
      screen.getByRole('button', { name: 'Continue with Google' })
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Skip' }))

    expect(next).toHaveBeenCalledWith('skip')
    expect(telemetry.capture).not.toHaveBeenCalled()
  })

  it('signs in with an email code, then continues', async () => {
    const user = userEvent.setup()
    const { next } = await renderStep()

    await user.type(screen.getByLabelText('Email'), 'ada@example.com')
    await user.click(screen.getByRole('button', { name: 'Send code' }))
    await user.type(
      await screen.findByLabelText(
        'Enter the 6-digit code we sent to ada@example.com.'
      ),
      '123456'
    )

    expect(account.emailVerify).toHaveBeenCalledWith('ch1', '123456')
    const ready = await screen.findByTestId('onboarding-account-ready')
    expect(ready).toHaveTextContent('Ada Lovelace')
    expect(ready).toHaveTextContent('ada@example.com')
    expect(ready).toHaveTextContent('Signed in')
    expect(telemetry.capture).toHaveBeenCalledWith(
      'onboarding_account_signed_in',
      { method: 'email' }
    )

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(next).toHaveBeenCalledWith('continue')
  })

  it('signs in with Google', async () => {
    const user = userEvent.setup()
    await renderStep()

    await user.click(
      screen.getByRole('button', { name: 'Continue with Google' })
    )

    expect(
      await screen.findByTestId('onboarding-account-ready')
    ).toBeInTheDocument()
    expect(telemetry.capture).toHaveBeenCalledWith(
      'onboarding_account_signed_in',
      { method: 'google' }
    )
  })

  it('opens on the account when this device is already signed in', async () => {
    await renderStep(signedIn)

    expect(
      await screen.findByTestId('onboarding-account-ready')
    ).toHaveTextContent('Ada Lovelace')
    expect(
      screen.queryByTestId('onboarding-account-sign-in')
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
  })
})
