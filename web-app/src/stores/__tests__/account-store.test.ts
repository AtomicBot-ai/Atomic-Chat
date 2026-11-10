import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import type {
  AccountChangedEvent,
  AccountService,
  AccountStatus,
} from '@/services/account/types'
import { resetAccountStore, useAccountStore } from '@/stores/account-store'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }))

const ada = {
  id: 'u1',
  email: 'ada@example.com',
  displayName: null,
  avatarUrl: null,
}
const signedIn: AccountStatus = { signedIn: true, user: ada }
const signedOut: AccountStatus = { signedIn: false, user: null }

let emit: (event: AccountChangedEvent) => void
let account: {
  status: ReturnType<typeof vi.fn<() => Promise<AccountStatus>>>
  onChanged: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  resetAccountStore()
  vi.mocked(toast.warning).mockClear()
  account = {
    status: vi.fn(async () => signedIn),
    onChanged: vi.fn(async (callback: (event: AccountChangedEvent) => void) => {
      emit = callback
      return () => {}
    }),
  }
  seedServiceHub({ account: account as unknown as AccountService })
})

describe('account store', () => {
  it('reads the status and subscribes once, however often it is hydrated', async () => {
    const { hydrate } = useAccountStore.getState()
    await Promise.all([hydrate(), hydrate()])
    await hydrate()

    expect(account.status).toHaveBeenCalledTimes(1)
    expect(account.onChanged).toHaveBeenCalledTimes(1)
    expect(useAccountStore.getState()).toMatchObject({
      status: signedIn,
      hydrated: true,
    })
  })

  it('follows account-changed and says so when the session is lost', async () => {
    await useAccountStore.getState().hydrate()

    emit({ status: signedOut, reason: 'signedOut' })
    expect(useAccountStore.getState().status).toEqual(signedOut)
    expect(toast.warning).not.toHaveBeenCalled()

    emit({ status: signedIn, reason: 'signedIn' })
    emit({ status: signedOut, reason: 'sessionLost' })
    expect(useAccountStore.getState().status).toEqual(signedOut)
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it('keeps an event that lands while the status is being read', async () => {
    let answer: (status: AccountStatus) => void = () => {}
    account.status.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve))
    )
    const hydration = useAccountStore.getState().hydrate()
    await vi.waitFor(() => expect(account.status).toHaveBeenCalled())

    emit({ status: signedIn, reason: 'signedIn' })
    answer(signedOut)
    await hydration

    expect(useAccountStore.getState().status).toEqual(signedIn)
  })

  it('counts as hydrated, signed out, when the status cannot be read', async () => {
    account.status.mockRejectedValueOnce(new Error('no bridge'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await useAccountStore.getState().hydrate()

    expect(useAccountStore.getState()).toMatchObject({
      status: signedOut,
      hydrated: true,
    })
    warn.mockRestore()
  })
})
