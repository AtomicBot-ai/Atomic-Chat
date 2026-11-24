import { toast } from 'sonner'
import { create } from 'zustand'

import { getServiceHub } from '@/hooks/useServiceHub'
import i18n from '@/i18n/setup'
import {
  desktopNotificationsEnabled,
  isWindowAway,
  showDesktopNotification,
} from '@/lib/notifications'
import {
  keepPending,
  requestDeviceName,
  takeNewRequests,
} from '@/lib/remoteRequestNotice'
import {
  EMPTY_REMOTE_STATUS,
  type RemoteConnectionEnded,
  type RemoteDeviceLeft,
  type RemoteStatus,
} from '@/services/account/remote-types'

/**
 * Remote access as the Remote models page shows it. Not persisted: Rust owns
 * the state; this mirrors `account_remote_status` and the
 * `account-remote-changed` events after it.
 */
type AccountRemoteStore = {
  status: RemoteStatus
  hydrated: boolean
  /**
   * Pending requests the corner card leaves out: put away there, or seen on
   * the Remote models page. Only ids still pending.
   */
  acknowledgedRequests: string[]
  /** Reads the status and starts following changes. Idempotent. */
  hydrate: () => Promise<void>
  setStatus: (status: RemoteStatus) => void
  acknowledgeRequests: (grantIds: string[]) => void
}

let hydration: Promise<void> | null = null
let eventCount = 0
/** Requests already announced, so one notification per device asking. */
const announced = new Set<string>()

/**
 * A device asking for access while the window is away (hidden, minimized or
 * behind another app): one OS notification per request. In front, the corner
 * card (`RemoteRequestNotice`) or the Remote models page shows it instead.
 */
function announceNewRequests(status: RemoteStatus) {
  const fresh = takeNewRequests(status.requests, announced)
  if (fresh.length === 0 || !isWindowAway()) return
  if (!desktopNotificationsEnabled()) return
  for (const request of fresh) {
    void showDesktopNotification(
      i18n.t('account:remote.notice.title'),
      i18n.t('account:remote.notice.osBody', {
        name: requestDeviceName(i18n.t, request),
      })
    )
  }
}

const ENDED_REASON_KEYS: Record<string, string> = {
  denied: 'account:remote.ended.denied',
  expired: 'account:remote.ended.expired',
  not_answered: 'account:remote.ended.expired',
  not_delivered: 'account:remote.ended.expired',
  not_collected: 'account:remote.ended.expired',
  // The host revoked it, or stopped sharing and so revoked every device.
  revoked_by_user: 'account:remote.ended.byHost',
  // The server deletes a host that stops sharing for good, is removed from
  // the account, or signs out, and its grants with it: the grant read is a 404.
  grant_not_found: 'account:remote.ended.hostStopped',
  // Set on this device's own grants: this computer's session ended.
  signed_out: 'account:remote.ended.signedOut',
  key_changed: 'account:remote.ended.revoked',
  untrusted_credential: 'account:remote.ended.untrusted',
  unreadable_credential: 'account:remote.ended.untrusted',
}

/** Closed because this device paired with the same host again: the new grant carries on. */
const SILENT_REASONS = new Set(['replaced'])

function onConnectionEnded(event: RemoteConnectionEnded) {
  if (SILENT_REASONS.has(event.reason)) return
  const key = ENDED_REASON_KEYS[event.reason] ?? 'account:remote.ended.other'
  const name = event.hostName || i18n.t('account:remote.unknownComputer')
  if (event.reason === 'untrusted_credential') {
    toast.error(i18n.t(key, { name }))
  } else {
    toast.info(i18n.t(key, { name }))
  }
}

/** A device's access to this computer ended from its side. */
function onDeviceLeft(event: RemoteDeviceLeft) {
  const name =
    event.deviceName?.trim() || i18n.t('account:remote.unknownDevice')
  toast.info(i18n.t('account:remote.toast.deviceLeft', { name }), {
    id: `remote-left-${event.grantId}`,
  })
}

/**
 * A computer this device uses went offline: once, when it goes. Its toast
 * leaves when it comes back.
 */
function announceOffline(before: RemoteStatus, after: RemoteStatus) {
  for (const connection of after.connections) {
    const id = `remote-offline-${connection.grantId}`
    const was = before.connections.find((c) => c.grantId === connection.grantId)
    if (connection.offline && was && !was.offline) {
      toast.info(
        i18n.t('account:remote.toast.offline', {
          name: connection.hostName || i18n.t('account:remote.unknownComputer'),
        }),
        { id, description: i18n.t('account:remote.toast.offlineDesc') }
      )
    } else if (!connection.offline && was?.offline) {
      toast.dismiss(id)
    }
  }
}

function announce(status: RemoteStatus) {
  announceNewRequests(status)
  announceOffline(useAccountRemoteStore.getState().status, status)
}

/** The new status, with the acknowledged requests that are still pending. */
function next(status: RemoteStatus) {
  announce(status)
  return {
    status,
    hydrated: true,
    acknowledgedRequests: keepPending(
      useAccountRemoteStore.getState().acknowledgedRequests,
      status.requests
    ),
  }
}

function apply(status: RemoteStatus) {
  useAccountRemoteStore.setState(next(status))
}

async function runHydration(): Promise<void> {
  try {
    const account = getServiceHub().account()
    try {
      await account.onRemoteChanged((status) => {
        eventCount += 1
        apply(status)
      })
      await account.onRemoteConnectionEnded(onConnectionEnded)
      await account.onRemoteDeviceLeft(onDeviceLeft)
    } catch (error) {
      console.warn('Failed to follow remote access changes:', error)
    }
    const before = eventCount
    const status = await account.remoteStatus()
    // An event that arrived while reading is newer than the read.
    if (eventCount === before) apply(status)
  } catch (error) {
    console.warn('Failed to read the remote access state:', error)
  } finally {
    useAccountRemoteStore.setState({ hydrated: true })
  }
}

export const useAccountRemoteStore = create<AccountRemoteStore>()((set) => ({
  status: EMPTY_REMOTE_STATUS,
  hydrated: false,
  acknowledgedRequests: [],
  hydrate: () => {
    hydration ??= runHydration()
    return hydration
  },
  setStatus: (status) => set(next(status)),
  acknowledgeRequests: (grantIds) =>
    set((state) => {
      const added = grantIds.filter(
        (grantId) => !state.acknowledgedRequests.includes(grantId)
      )
      return added.length === 0
        ? state
        : { acknowledgedRequests: [...state.acknowledgedRequests, ...added] }
    }),
}))

/** Tests only: forget the hydration and the announced requests. */
export function resetAccountRemoteStoreForTests() {
  hydration = null
  eventCount = 0
  announced.clear()
  useAccountRemoteStore.setState({
    status: EMPTY_REMOTE_STATUS,
    hydrated: false,
    acknowledgedRequests: [],
  })
}
