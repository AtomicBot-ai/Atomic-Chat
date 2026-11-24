import { toast } from 'sonner'
import { create } from 'zustand'

import { getServiceHub } from '@/hooks/useServiceHub'
import i18n from '@/i18n/setup'
import {
  SIGNED_OUT,
  type AccountChangedEvent,
  type AccountSession,
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
  /**
   * The devices list as last loaded, so the account page shows it at once on
   * the next visit and refreshes it in place. Only for the user it belongs to.
   */
  devices: { userId: string; sessions: AccountSession[] } | null
  setDevices: (userId: string, sessions: AccountSession[]) => void
}

const SESSION_LOST_TOAST_ID = 'account-session-lost'

let hydration: Promise<void> | null = null
let unsubscribe: (() => void) | null = null
// Bumped by every event, so a status read that started before one cannot
// overwrite what the event said.
let eventCount = 0

/** The cached devices list survives only while the same user stays signed in. */
function devicesFor(
  status: AccountStatus,
  devices: AccountStore['devices']
): AccountStore['devices'] {
  return status.signedIn && status.user?.id === devices?.userId ? devices : null
}

function onAccountChanged(event: AccountChangedEvent) {
  eventCount += 1
  useAccountStore.setState((state) => ({
    status: event.status,
    hydrated: true,
    devices: devicesFor(event.status, state.devices),
  }))
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
    if (eventCount === before)
      useAccountStore.setState((state) => ({
        status,
        devices: devicesFor(status, state.devices),
      }))
  } catch (error) {
    console.warn('Failed to read the account status:', error)
  } finally {
    useAccountStore.setState({ hydrated: true })
  }
}

export const useAccountStore = create<AccountStore>()((set, get) => ({
  status: SIGNED_OUT,
  hydrated: false,
  devices: null,

  hydrate: () => {
    hydration ??= runHydration()
    return hydration
  },

  setStatus: (status) =>
    set((state) => ({
      status,
      hydrated: true,
      devices: devicesFor(status, state.devices),
    })),

  setUser: (user) => {
    const { status } = get()
    if (!status.signedIn || status.user?.id !== user.id) return
    set({ status: { signedIn: true, user } })
  },

  setDevices: (userId, sessions) => {
    const { status } = get()
    if (!status.signedIn || status.user?.id !== userId) return
    set({ devices: { userId, sessions } })
  },
}))

/** Back to the never-hydrated state, unsubscribed. For tests. */
export function resetAccountStore(): void {
  unsubscribe?.()
  unsubscribe = null
  hydration = null
  eventCount = 0
  useAccountStore.setState({
    status: SIGNED_OUT,
    hydrated: false,
    devices: null,
  })
}
