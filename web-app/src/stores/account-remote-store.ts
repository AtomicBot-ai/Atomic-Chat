import { toast } from 'sonner'
import { create } from 'zustand'

import { getServiceHub } from '@/hooks/useServiceHub'
import i18n from '@/i18n/setup'
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
  /** Reads the status and starts following changes. Idempotent. */
  hydrate: () => Promise<void>
  setStatus: (status: RemoteStatus) => void
}

let hydration: Promise<void> | null = null
let eventCount = 0
/** Requests already announced, so one toast per device asking. */
const announced = new Set<string>()

/** Where a toast's "Review" goes; the root route sets it to a router navigation. */
let openRemotePage: () => void = () => {}

export function setRemotePageOpener(open: () => void) {
  openRemotePage = open
}

function announceNewRequests(status: RemoteStatus) {
  for (const request of status.requests) {
    if (announced.has(request.grantId)) continue
    announced.add(request.grantId)
    const name =
      request.deviceName?.trim() || i18n.t('account:remote.unknownDevice')
    toast.info(i18n.t('account:remote.toast.request', { name }), {
      id: `remote-request-${request.grantId}`,
      description: i18n.t('account:remote.toast.requestDesc', {
        code: request.checkCode,
      }),
      action: {
        label: i18n.t('account:remote.toast.review'),
        onClick: () => openRemotePage(),
      },
    })
  }
}

const ENDED_REASON_KEYS: Record<string, string> = {
  denied: 'account:remote.ended.denied',
  expired: 'account:remote.ended.expired',
  // The host revoked it or stopped sharing.
  revoked_by_user: 'account:remote.ended.byHost',
  signed_out: 'account:remote.ended.hostSignedOut',
  key_changed: 'account:remote.ended.revoked',
  not_collected: 'account:remote.ended.expired',
  untrusted_credential: 'account:remote.ended.untrusted',
  unreadable_credential: 'account:remote.ended.untrusted',
}

function onConnectionEnded(event: RemoteConnectionEnded) {
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

function apply(status: RemoteStatus) {
  announce(status)
  useAccountRemoteStore.setState({ status, hydrated: true })
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
  hydrate: () => {
    hydration ??= runHydration()
    return hydration
  },
  setStatus: (status) => {
    announce(status)
    set({ status, hydrated: true })
  },
}))

/** Tests only: forget the hydration and the announced requests. */
export function resetAccountRemoteStoreForTests() {
  hydration = null
  eventCount = 0
  announced.clear()
  useAccountRemoteStore.setState({
    status: EMPTY_REMOTE_STATUS,
    hydrated: false,
  })
}
