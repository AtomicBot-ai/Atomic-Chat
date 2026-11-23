import { beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))

const account = vi.hoisted(() => ({
  remoteStatus: vi.fn(),
  onRemoteChanged: vi.fn(),
  onRemoteConnectionEnded: vi.fn(),
  onRemoteDeviceLeft: vi.fn(),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ account: () => account }),
}))

// The window's focus and the Settings switch, as the store reads them.
const os = vi.hoisted(() => ({
  away: false,
  enabled: true,
  show: vi.fn(async (_title: string, _body: string) => {}),
}))
vi.mock('@/lib/notifications', () => ({
  isWindowAway: () => os.away,
  desktopNotificationsEnabled: () => os.enabled,
  showDesktopNotification: os.show,
}))

import {
  EMPTY_REMOTE_STATUS,
  type RemoteConnectionEnded,
  type RemoteConnectionView,
  type RemoteDeviceLeft,
  type RemoteStatus,
} from '@/services/account/remote-types'
import {
  resetAccountRemoteStoreForTests,
  useAccountRemoteStore,
} from '@/stores/account-remote-store'

const DEVICE_NAMES: Record<string, string | null> = {
  g1: "Ann's iPhone",
  g2: 'Studio Mac',
  g3: null,
}

const asking = (...grantIds: string[]): RemoteStatus => ({
  ...EMPTY_REMOTE_STATUS,
  sharing: true,
  requests: grantIds.map((grantId) => ({
    grantId,
    deviceName: DEVICE_NAMES[grantId] ?? null,
    platform: 'ios',
    clientType: 'mobile',
    checkCode: '123456',
    createdAt: '2026-11-12T10:00:00Z',
  })),
})

let changed: (status: RemoteStatus) => void
let ended: (event: RemoteConnectionEnded) => void
let left: (event: RemoteDeviceLeft) => void

const using = (offline: boolean): RemoteStatus => ({
  ...EMPTY_REMOTE_STATUS,
  connections: [
    {
      grantId: 'g-use',
      hostId: 'host-studio',
      hostName: 'Studio Mac',
      status: 'active',
      ready: true,
      via: 'lan',
      offline,
      checkCode: null,
    } satisfies RemoteConnectionView,
  ],
})

describe('account remote store', () => {
  beforeEach(() => {
    resetAccountRemoteStoreForTests()
    vi.clearAllMocks()
    os.away = false
    os.enabled = true
    account.remoteStatus.mockResolvedValue(EMPTY_REMOTE_STATUS)
    account.onRemoteChanged.mockImplementation(async (cb) => {
      changed = cb
      return () => {}
    })
    account.onRemoteConnectionEnded.mockImplementation(async (cb) => {
      ended = cb
      return () => {}
    })
    account.onRemoteDeviceLeft.mockImplementation(async (cb) => {
      left = cb
      return () => {}
    })
  })

  it('reads the state once and follows its changes', async () => {
    await Promise.all([
      useAccountRemoteStore.getState().hydrate(),
      useAccountRemoteStore.getState().hydrate(),
    ])
    expect(account.remoteStatus).toHaveBeenCalledTimes(1)
    expect(useAccountRemoteStore.getState().hydrated).toBe(true)

    changed({ ...EMPTY_REMOTE_STATUS, sharing: true })
    expect(useAccountRemoteStore.getState().status.sharing).toBe(true)
  })

  it('a status read that started before an event does not overwrite it', async () => {
    let answer: (status: RemoteStatus) => void = () => {}
    account.remoteStatus.mockReturnValue(
      new Promise<RemoteStatus>((resolve) => (answer = resolve))
    )
    const hydration = useAccountRemoteStore.getState().hydrate()
    await vi.waitFor(() => expect(account.remoteStatus).toHaveBeenCalled())

    changed({ ...EMPTY_REMOTE_STATUS, sharing: true })
    answer(EMPTY_REMOTE_STATUS)
    await hydration

    expect(useAccountRemoteStore.getState().status.sharing).toBe(true)
  })

  it('tells the OS once per device asking while the window is away', async () => {
    os.away = true
    await useAccountRemoteStore.getState().hydrate()

    changed(asking('g1'))
    changed(asking('g1'))
    changed(asking('g1', 'g2', 'g3'))

    expect(os.show.mock.calls).toEqual([
      [
        'Access request',
        "Ann's iPhone asks to use this computer's models. Open Atomic Chat to allow or deny it.",
      ],
      [
        'Access request',
        "Studio Mac asks to use this computer's models. Open Atomic Chat to allow or deny it.",
      ],
      [
        'Access request',
        "iOS device asks to use this computer's models. Open Atomic Chat to allow or deny it.",
      ],
    ])
    // The corner card is the in-app notice now, not a toast.
    expect(toast.info.mock.calls).toEqual([])
    expect(
      useAccountRemoteStore.getState().status.requests.map((r) => r.grantId)
    ).toEqual(['g1', 'g2', 'g3'])
  })

  it('tells the OS about a request that was already pending at start, once', async () => {
    os.away = true
    account.remoteStatus.mockResolvedValue(asking('g1'))

    await useAccountRemoteStore.getState().hydrate()
    changed(asking('g1'))

    expect(os.show.mock.calls.map((call) => call[1])).toEqual([
      "Ann's iPhone asks to use this computer's models. Open Atomic Chat to allow or deny it.",
    ])
  })

  it('leaves a request to the corner card while the window is in front', async () => {
    await useAccountRemoteStore.getState().hydrate()

    changed(asking('g1'))
    // Away later: the request was already announced, the card still has it.
    os.away = true
    changed(asking('g1'))

    expect(os.show.mock.calls).toEqual([])
    expect(useAccountRemoteStore.getState().status.requests).toHaveLength(1)
    expect(useAccountRemoteStore.getState().acknowledgedRequests).toEqual([])
  })

  it('stays quiet when desktop notifications are off in Settings', async () => {
    os.away = true
    os.enabled = false
    await useAccountRemoteStore.getState().hydrate()

    changed(asking('g1'))

    expect(os.show.mock.calls).toEqual([])
    expect(useAccountRemoteStore.getState().status.requests).toHaveLength(1)
  })

  it('forgets acknowledged requests once they are allowed, denied or expired', async () => {
    await useAccountRemoteStore.getState().hydrate()
    changed(asking('g1', 'g2'))

    const { acknowledgeRequests } = useAccountRemoteStore.getState()
    acknowledgeRequests(['g1'])
    acknowledgeRequests(['g1'])
    expect(useAccountRemoteStore.getState().acknowledgedRequests).toEqual([
      'g1',
    ])

    // g1 was decided; g2 still waits.
    changed(asking('g2'))
    expect(useAccountRemoteStore.getState().acknowledgedRequests).toEqual([])

    acknowledgeRequests(['g2'])
    useAccountRemoteStore.getState().setStatus(EMPTY_REMOTE_STATUS)
    expect(useAccountRemoteStore.getState().acknowledgedRequests).toEqual([])
  })

  it('says when access ended, louder when a key was refused', async () => {
    await useAccountRemoteStore.getState().hydrate()

    ended({ hostName: 'Studio Mac', reason: 'denied' })
    ended({ hostName: 'Studio Mac', reason: 'untrusted_credential' })

    expect(toast.info).toHaveBeenCalledWith('Studio Mac declined access.')
    expect(toast.error.mock.calls[0][0]).toBe(
      'The key from Studio Mac could not be verified, so it was refused.'
    )
  })

  it("names the computer that ended this device's access", async () => {
    await useAccountRemoteStore.getState().hydrate()

    ended({ hostName: 'Studio Mac', reason: 'revoked_by_user' })
    // The host is gone from the account (stopped sharing for good, removed,
    // signed out): the server deleted the grant, so its read was a 404.
    ended({ hostName: 'Studio Mac', reason: 'grant_not_found' })

    expect(toast.info.mock.calls.map((call) => call[0])).toEqual([
      'Studio Mac ended your access.',
      'Studio Mac stopped sharing.',
    ])
  })

  it('blames this computer, not the host, when its own session ended', async () => {
    await useAccountRemoteStore.getState().hydrate()

    ended({ hostName: 'Studio Mac', reason: 'signed_out' })

    expect(toast.info.mock.calls.map((call) => call[0])).toEqual([
      'This computer was signed out, so access to Studio Mac ended.',
    ])
  })

  it('says a request expired whichever deadline closed it', async () => {
    await useAccountRemoteStore.getState().hydrate()

    ended({ hostName: 'Studio Mac', reason: 'not_answered' })
    ended({ hostName: 'Studio Mac', reason: 'not_delivered' })
    ended({ hostName: 'Studio Mac', reason: 'not_collected' })

    expect(toast.info.mock.calls.map((call) => call[0])).toEqual([
      'The request to Studio Mac expired.',
      'The request to Studio Mac expired.',
      'The request to Studio Mac expired.',
    ])
  })

  it('stays quiet when pairing again replaced the old grant', async () => {
    await useAccountRemoteStore.getState().hydrate()

    ended({ hostName: 'Studio Mac', reason: 'replaced' })
    ended({ hostName: 'Studio Mac', reason: 'denied' })

    // Only the second ending is told.
    expect(toast.info.mock.calls.map((call) => call[0])).toEqual([
      'Studio Mac declined access.',
    ])
    expect(toast.error.mock.calls).toEqual([])
  })

  it('says when a device disconnected from this computer', async () => {
    await useAccountRemoteStore.getState().hydrate()

    left({ grantId: 'g7', deviceName: "Ann's iPhone" })
    left({ grantId: 'g8', deviceName: null })

    expect(toast.info.mock.calls).toEqual([
      ["Ann's iPhone disconnected", { id: 'remote-left-g7' }],
      ['Unknown device disconnected', { id: 'remote-left-g8' }],
    ])
  })

  it('says once when a computer in use goes offline, and clears it when it is back', async () => {
    await useAccountRemoteStore.getState().hydrate()

    changed(using(false))
    changed(using(true))
    changed(using(true))

    expect(toast.info.mock.calls).toEqual([
      [
        'Studio Mac is offline',
        {
          id: 'remote-offline-g-use',
          description: 'Its models come back when it does.',
        },
      ],
    ])
    expect(useAccountRemoteStore.getState().status.connections[0].offline).toBe(
      true
    )

    changed(using(false))
    expect(toast.dismiss.mock.calls).toEqual([['remote-offline-g-use']])
    expect(useAccountRemoteStore.getState().status.connections[0].offline).toBe(
      false
    )
  })

  it('does not announce a computer that was already offline at start', async () => {
    account.remoteStatus.mockResolvedValue(using(true))

    await useAccountRemoteStore.getState().hydrate()

    expect(useAccountRemoteStore.getState().status.connections[0].offline).toBe(
      true
    )
    expect(toast.info.mock.calls).toEqual([])
  })
})
