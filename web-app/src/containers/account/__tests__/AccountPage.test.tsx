import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TranslationContext } from '@/i18n/context'
import i18n from '@/i18n/setup'
import type {
  AccountProfile,
  AccountService,
  AccountSession,
  AccountStatus,
} from '@/services/account/types'
import { resetAccountStore, useAccountStore } from '@/stores/account-store'
import { seedServiceHub } from '@/test/service-hub'
import { AccountPage } from '../AccountPage'

const ada = {
  id: 'u1',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  avatarUrl: null,
}
const profile: AccountProfile = {
  user: ada,
  createdAt: '2026-11-01T10:00:00Z',
  identities: [
    { provider: 'google', email: 'ada@example.com', createdAt: '' },
    { provider: 'email', email: 'ada@example.com', createdAt: '' },
  ],
}
const session = (over: Partial<AccountSession>): AccountSession => ({
  id: 's1',
  clientType: 'desktop',
  deviceName: null,
  platform: 'macos',
  appVersion: '2.4.0',
  authMethod: 'email',
  createdAt: '2026-11-01T10:00:00Z',
  lastUsedAt: new Date().toISOString(),
  expiresAt: '2026-12-01T10:00:00Z',
  current: false,
  ...over,
})

function mockAccount(status: AccountStatus) {
  return {
    status: vi.fn(async () => status),
    onChanged: vi.fn(async () => () => {}),
    providers: vi.fn(async () => ['email']),
    profile: vi.fn(async () => profile),
    updateProfile: vi.fn(
      async (displayName: string): Promise<AccountProfile> => ({
        ...profile,
        user: { ...ada, displayName },
      })
    ),
    sessions: vi.fn(async () => [
      session({ id: 'other', deviceName: 'Office PC', platform: 'windows' }),
      session({ id: 'mine', deviceName: 'MacBook', current: true }),
      session({
        id: 'server',
        clientType: 'server',
        deviceName: 'home-server',
        platform: 'atc-linux',
        appVersion: '0.2.13',
        // Used before Office PC, so the order does not hang on which fixture
        // happened to be built a millisecond later.
        lastUsedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]),
    revokeSession: vi.fn(async () => {}),
  }
}

let account: ReturnType<typeof mockAccount>

async function renderPage(status: AccountStatus) {
  account = mockAccount(status)
  seedServiceHub({ account: account as unknown as AccountService })
  await act(async () => {
    render(
      <TranslationContext.Provider value={{ t: i18n.t, i18n }}>
        <AccountPage />
      </TranslationContext.Provider>
    )
    // One macrotask, so the async effects' answers land inside act too.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  resetAccountStore()
})

describe('AccountPage', () => {
  it('offers sign-in while signed out', async () => {
    await renderPage({ signedIn: false, user: null })

    // Settings rows. Without Google (this mock offers only email), the email
    // row is the sign-in row itself.
    expect(await screen.findByText('Sign in')).toBeInTheDocument()
    expect(screen.queryByText('Email code')).not.toBeInTheDocument()
    expect(
      within(screen.getByTestId('account-sign-in')).getByRole('textbox', {
        name: 'Email',
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Send code' })
    ).toBeInTheDocument()
    expect(account.profile).not.toHaveBeenCalled()
  })

  it('shows the profile and the devices once signed in', async () => {
    await renderPage({ signedIn: true, user: ada })

    expect(await screen.findByTestId('account-name')).toHaveTextContent(
      'Ada Lovelace'
    )
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()
    // Sign-in methods are not listed on the page.
    expect(screen.queryByText('Email code')).not.toBeInTheDocument()
    expect(account.profile).toHaveBeenCalledTimes(1)

    const rows = await screen.findAllByTestId('account-device')
    // This device first.
    expect(rows[0]).toHaveTextContent('MacBook')
    expect(rows[0]).toHaveTextContent('This device')
    expect(within(rows[0]).queryByRole('button')).not.toBeInTheDocument()
    expect(rows[1]).toHaveTextContent('Office PC')
    expect(rows[1]).toHaveTextContent('Windows · Atomic Chat 2.4.0 · Active')
    // Atomic Server names itself, not the desktop app.
    expect(rows[2]).toHaveTextContent('home-server')
    expect(rows[2]).toHaveTextContent('Linux · Atomic Server 0.2.13 · Active')
    expect(
      screen.getByRole('button', { name: 'Delete account' })
    ).toBeInTheDocument()
  })

  it('holds one device-shaped row in place while the list loads', async () => {
    const pending = new Promise<AccountSession[]>(() => {})
    account = mockAccount({ signedIn: true, user: ada })
    account.sessions.mockReturnValue(pending)
    seedServiceHub({ account: account as unknown as AccountService })
    await act(async () => {
      render(
        <TranslationContext.Provider value={{ t: i18n.t, i18n }}>
          <AccountPage />
        </TranslationContext.Provider>
      )
    })

    expect(screen.getByTestId('account-devices-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('account-device')).not.toBeInTheDocument()
  })

  it('shows the last list at once on the next visit, then refreshes it', async () => {
    await renderPage({ signedIn: true, user: ada })
    expect(await screen.findAllByTestId('account-device')).toHaveLength(3)
    cleanup()

    const pending = new Promise<AccountSession[]>(() => {})
    account.sessions.mockReturnValueOnce(pending)
    render(
      <TranslationContext.Provider value={{ t: i18n.t, i18n }}>
        <AccountPage />
      </TranslationContext.Provider>
    )

    expect(screen.getAllByTestId('account-device')).toHaveLength(3)
    expect(
      screen.queryByTestId('account-devices-loading')
    ).not.toBeInTheDocument()
  })

  it('signs another device out and reloads the list', async () => {
    const user = userEvent.setup()
    await renderPage({ signedIn: true, user: ada })

    const rows = await screen.findAllByTestId('account-device')
    account.sessions.mockResolvedValueOnce([
      session({ id: 'mine', deviceName: 'MacBook', current: true }),
    ])
    await user.click(within(rows[1]).getByRole('button'))

    expect(account.revokeSession).toHaveBeenCalledWith('other')
    await waitFor(() =>
      expect(screen.getAllByTestId('account-device')).toHaveLength(1)
    )
  })

  it('renames the account in place', async () => {
    const user = userEvent.setup()
    await renderPage({ signedIn: true, user: ada })

    await user.click(
      await screen.findByRole('button', { name: 'Edit display name' })
    )
    const name = screen.getByRole('textbox', { name: 'Display name' })
    await user.clear(name)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Use 1 to 100 characters.'
    )
    expect(account.updateProfile).not.toHaveBeenCalled()

    await user.type(name, '  Countess  ')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(account.updateProfile).toHaveBeenCalledWith('Countess')
    await waitFor(() =>
      expect(screen.getByTestId('account-name')).toHaveTextContent('Countess')
    )
    expect(useAccountStore.getState().status.user?.displayName).toBe('Countess')
  })
})
