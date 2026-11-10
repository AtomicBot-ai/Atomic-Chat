import { toast } from 'sonner'
import { create } from 'zustand'

import { getServiceHub } from '@/hooks/useServiceHub'
import i18n from '@/i18n/setup'
import {
  SIGNED_OUT,
  type AccountChangedEvent,
  type AccountStatus,
  type AccountUser,
} from '@/services/account/types'

/**
 * The Atomic Chat account as the UI shows it. Not persisted: the Rust side
 * owns the session, and this store only mirrors `account_status` and the
 * `account-changed` events that follow it.
 */
type AccountStore = {
  status: AccountStatus
  /** `status` has been read from the backend at least once (or the read failed). */
  hydrated: boolean
  /**
   * Reads the status and starts following `account-changed`. Idempotent: the
   * first call does the work, later calls share its promise.
   */
  hydrate: () => Promise<void>
  setStatus: (status: AccountStatus) => void
  /** A fresher copy of the signed-in user, e.g. from `account_profile`. */
  setUser: (user: AccountUser) => void
}

const SESSION_LOST_TOAST_ID = 'account-session-lost'

let hydration: Promise<void> | null = null
let unsubscribe: (() => void) | null = null
// Bumped by every event, so a status read that started before one cannot
// overwrite what the event said.
let eventCount = 0

function onAccountChanged(event: AccountChangedEvent) {
  eventCount += 1
  useAccountStore.setState({ status: event.status, hydrated: true })
  if (event.reason === 'sessionLost') {
    toast.warning(i18n.t('account:toast.sessionLost'), {
      id: SESSION_LOST_TOAST_ID,
      description: i18n.t('account:toast.sessionLostDesc'),
    })
  }
}

async function runHydration(): Promise<void> {
  try {
    const account = getServiceHub().account()
    // Subscribe first: a sign-in that lands while the status is read still
    // reaches the store.
    try {
      unsubscribe = await account.onChanged(onAccountChanged)
    } catch (error) {
      console.warn('Failed to follow account changes:', error)
    }
    const before = eventCount
    const status = await account.status()
    if (eventCount === before) useAccountStore.setState({ status })
  } catch (error) {
    console.warn('Failed to read the account status:', error)
  } finally {
    useAccountStore.setState({ hydrated: true })
  }
}

export const useAccountStore = create<AccountStore>()((set, get) => ({
  status: SIGNED_OUT,
  hydrated: false,

  hydrate: () => {
    hydration ??= runHydration()
    return hydration
  },

  setStatus: (status) => set({ status, hydrated: true }),

  setUser: (user) => {
    const { status } = get()
    if (!status.signedIn || status.user?.id !== user.id) return
    set({ status: { signedIn: true, user } })
  },
}))

/** Back to the never-hydrated state, unsubscribed. For tests. */
export function resetAccountStore(): void {
  unsubscribe?.()
  unsubscribe = null
  hydration = null
  eventCount = 0
  useAccountStore.setState({ status: SIGNED_OUT, hydrated: false })
}
