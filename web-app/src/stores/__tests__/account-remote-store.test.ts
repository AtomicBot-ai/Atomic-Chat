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

const asking = (grantId: string): RemoteStatus => ({
  ...EMPTY_REMOTE_STATUS,
  sharing: true,
  requests: [
    {
      grantId,
      deviceName: "Ann's iPhone",
      platform: 'ios',
      clientType: 'mobile',
      checkCode: '123456',
      createdAt: '2026-11-12T10:00:00Z',
    },
  ],
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

  it('announces each device asking for access once', async () => {
    await useAccountRemoteStore.getState().hydrate()

    changed(asking('g1'))
    changed(asking('g1'))
    changed(asking('g2'))

    expect(toast.info).toHaveBeenCalledTimes(2)
    expect(toast.info.mock.calls[0][1]).toMatchObject({
      id: 'remote-request-g1',
      description: expect.stringContaining('123456'),
    })
    expect(toast.info.mock.calls[1][0]).toBe(
      "Ann's iPhone asks to use this computer's models"
    )
    expect(useAccountRemoteStore.getState().status.requests[0].grantId).toBe(
      'g2'
    )
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
    ended({ hostName: 'Studio Mac', reason: 'signed_out' })

    expect(toast.info.mock.calls.map((call) => call[0])).toEqual([
      'Studio Mac ended your access.',
      'Studio Mac stopped sharing.',
    ])
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
