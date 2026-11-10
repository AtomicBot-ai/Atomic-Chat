import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TranslationContext } from '@/i18n/context'
import i18n from '@/i18n/setup'
import type { AccountService, AccountStatus } from '@/services/account/types'
import { resetAccountStore, useAccountStore } from '@/stores/account-store'
import { seedServiceHub } from '@/test/service-hub'
import { DeleteAccountDialog } from '../DeleteAccountDialog'

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

const ada = {
  id: 'u1',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  avatarUrl: null,
}
const grace = { ...ada, id: 'u2', displayName: 'Grace Hopper' }
const signedOut: AccountStatus = { signedIn: false, user: null }
const reauthRequired = {
  code: 'reauth_required',
  message: 'reauth_required',
  attemptsLeft: null,
  retryAfter: null,
}

function mockAccount(signsInAs: typeof ada) {
  return {
    providers: vi.fn(async () => ['email', 'google']),
    emailStart: vi.fn(async () => ({
      challengeId: 'ch1',
      expiresIn: 600,
      resendIn: 30,
    })),
    emailVerify: vi.fn(
      async (): Promise<AccountStatus> => ({ signedIn: true, user: signsInAs })
    ),
    cancelLogin: vi.fn(async () => {}),
    deleteAccount: vi
      .fn<() => Promise<AccountStatus>>()
      .mockRejectedValueOnce(reauthRequired)
      .mockResolvedValue(signedOut),
  }
}

let account: ReturnType<typeof mockAccount>

function renderDialog() {
  render(
    <TranslationContext.Provider value={{ t: i18n.t, i18n }}>
      <DeleteAccountDialog user={ada} />
    </TranslationContext.Provider>
  )
}

/** Delete → reauth_required → sign in again with an email code. */
async function deleteAndReauth(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('account-delete'))
  const dialog = await screen.findByRole('dialog')
  await user.click(
    within(dialog).getByRole('button', { name: 'Delete account' })
  )

  expect(
    await within(dialog).findByText("Confirm it's you")
  ).toBeInTheDocument()
  expect(account.deleteAccount).toHaveBeenCalledTimes(1)
  const email = within(dialog).getByLabelText('Email')
  expect(email).toHaveValue('ada@example.com')
  expect(email).toHaveAttribute('readonly')

  await user.click(within(dialog).getByRole('button', { name: 'Send code' }))
  await user.type(await within(dialog).findByLabelText('Code'), '123456')
  return dialog
}

beforeEach(() => {
  resetAccountStore()
  useAccountStore.setState({
    status: { signedIn: true, user: ada },
    hydrated: true,
  })
})

describe('DeleteAccountDialog', () => {
  it('deletes straight away when the sign-in is recent enough', async () => {
    account = mockAccount(ada)
    account.deleteAccount.mockReset().mockResolvedValue(signedOut)
    seedServiceHub({ account: account as unknown as AccountService })
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByTestId('account-delete'))
    const dialog = await screen.findByRole('dialog')
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete account' })
    )

    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(account.deleteAccount).toHaveBeenCalledTimes(1)
    expect(useAccountStore.getState().status).toEqual(signedOut)
  })

  it('retries the delete after the same account signs in again', async () => {
    account = mockAccount(ada)
    seedServiceHub({ account: account as unknown as AccountService })
    const user = userEvent.setup()
    renderDialog()

    await deleteAndReauth(user)

    await waitFor(() => expect(account.deleteAccount).toHaveBeenCalledTimes(2))
    expect(account.emailVerify).toHaveBeenCalledWith('ch1', '123456')
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
  })

  it('does not delete when a different account signs in', async () => {
    account = mockAccount(grace)
    seedServiceHub({ account: account as unknown as AccountService })
    const user = userEvent.setup()
    renderDialog()

    const dialog = await deleteAndReauth(user)

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'You signed in with a different account, so nothing was deleted.'
    )
    expect(account.deleteAccount).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
