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

const server = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  settle: vi.fn(async () => true),
  restart: vi.fn(async () => true),
  startTunnel: vi.fn(async () => true),
  refreshTunnel: vi.fn(async () => {}),
  servedWithKey: true as boolean | undefined,
}))

vi.mock('@/hooks/useLocalApiServerControl', () => ({
  useLocalApiServerControl: () => ({
    start: server.start,
    stop: server.stop,
    status: 'stopped',
  }),
}))

vi.mock('@/hooks/useRemoteAccess', () => ({
  startLocalApiServerAndSettle: server.settle,
  restartLocalApiServer: server.restart,
  startRemoteAccess: server.startTunnel,
  refreshRemoteAccessStatus: server.refreshTunnel,
  useRemoteAccessStore: {
    getState: () => ({ status: { serverHasApiKey: server.servedWithKey } }),
  },
}))

const remoteSync = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/account-remote-providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/account-remote-providers')>()),
  syncAccountRemoteProviders: remoteSync,
}))

const platform = vi.hoisted(() => ({
  accounts: true,
  localApiServer: true,
  remoteAccess: true,
}))
vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  return {
    PlatformFeatures: new Proxy(actual.PlatformFeatures, {
      get: (target, key) =>
        key in platform
          ? platform[key as keyof typeof platform]
          : target[key as keyof typeof target],
    }),
  }
})

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { TranslationContext } from '@/i18n/context'
import i18n from '@/i18n/setup'
import {
  EMPTY_REMOTE_STATUS,
  type RemoteHostInfo,
  type RemoteStatus,
} from '@/services/account/remote-types'
import type { AccountService, AccountStatus } from '@/services/account/types'
import {
  resetAccountRemoteStoreForTests,
  useAccountRemoteStore,
} from '@/stores/account-remote-store'
import { resetAccountStore } from '@/stores/account-store'
import { seedServiceHub } from '@/test/service-hub'
import { RemoteModelsPage } from '../RemoteModelsPage'

const ada = {
  id: 'u1',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  avatarUrl: null,
}

const sharing: RemoteStatus = {
  ...EMPTY_REMOTE_STATUS,
  sharing: true,
  host: { id: 'host-self', name: 'MacBook' },
  reach: {
    serverRunning: true,
    serverHasKey: true,
    tunnel: 'online',
    lan: false,
  },
}

const studio: RemoteHostInfo = {
  id: 'host-studio',
  name: 'Studio Mac',
  clientType: 'desktop',
  platform: 'macos',
  online: true,
  tunnelState: 'online',
  lanEnabled: true,
  lastSeenAt: new Date().toISOString(),
  createdAt: '2026-11-01T10:00:00Z',
  isSelf: false,
  myGrant: null,
}

function mockAccount(status: AccountStatus, remote: RemoteStatus) {
  return {
    status: vi.fn(async () => status),
    onChanged: vi.fn(async () => () => {}),
    providers: vi.fn(async () => ['email']),
    remoteStatus: vi.fn(async () => remote),
    onRemoteChanged: vi.fn(async () => () => {}),
    onRemoteConnectionEnded: vi.fn(async () => () => {}),
    remoteSetSharing: vi.fn(async (enabled: boolean) => ({
      ...(enabled ? sharing : EMPTY_REMOTE_STATUS),
    })),
    remoteDecide: vi.fn(async () => sharing),
    remoteRevoke: vi.fn(async () => ({ ...sharing, devices: [] })),
    remotePairingCode: vi.fn(async () => ({
      code: 'BCDF-GHJK',
      link: 'atomic-chat://remote/pair?c=BCDF-GHJK&k=secret',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    })),
    remoteClosePairingCode: vi.fn(async () => {}),
    remoteHosts: vi.fn(async () => [
      { ...studio, id: 'host-self', name: 'MacBook', isSelf: true },
      studio,
    ]),
    remoteRequest: vi.fn(async () => ({
      grantId: 'g-req',
      hostId: studio.id,
      hostName: studio.name,
      status: 'pending',
      ready: false,
      via: null,
      checkCode: '482915',
    })),
    remotePair: vi.fn(async () => ({
      grantId: 'g-pair',
      hostId: studio.id,
      hostName: studio.name,
      status: 'approved',
      ready: false,
      via: null,
      checkCode: null,
    })),
    remoteDisconnect: vi.fn(async () => EMPTY_REMOTE_STATUS),
    remoteRemoveHost: vi.fn(async () => EMPTY_REMOTE_STATUS),
    remoteConnections: vi.fn(async () => [studioConnection]),
  }
}

const studioConnection = {
  hostId: 'host-studio',
  hostName: 'Studio Mac',
  baseUrl: 'http://192.168.1.5:1337/v1',
  apiKey: 'sk-atomic-studio',
  endpointsSeq: 1,
}

let account: ReturnType<typeof mockAccount>

async function renderPage(status: AccountStatus, remote: RemoteStatus) {
  account = mockAccount(status, remote)
  seedServiceHub({ account: account as unknown as AccountService })
  await act(async () => {
    render(
      <TranslationContext.Provider value={{ t: i18n.t, i18n }}>
        <RemoteModelsPage />
      </TranslationContext.Provider>
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const signedIn: AccountStatus = { signedIn: true, user: ada }

beforeEach(() => {
  cleanup()
  resetAccountStore()
  resetAccountRemoteStoreForTests()
  vi.clearAllMocks()
  server.servedWithKey = true
  useLocalApiServer.getState().setApiKey('')
  useAppState.setState({ serverStatus: 'stopped' })
})

describe('RemoteModelsPage', () => {
  it('asks to sign in first', async () => {
    await renderPage({ signedIn: false, user: null }, EMPTY_REMOTE_STATUS)

    expect(
      screen.getByText(
        "Sign in to share this computer's models with your other devices and to use theirs."
      )
    ).toBeInTheDocument()
    expect(screen.queryByTestId('share-switch')).not.toBeInTheDocument()
    expect(account.remoteHosts).not.toHaveBeenCalled()
  })

  it('creates a server key with consent, then starts the server, the tunnel and sharing', async () => {
    await renderPage(signedIn, EMPTY_REMOTE_STATUS)
    const user = userEvent.setup()

    await user.click(screen.getByTestId('share-switch'))
    const dialog = await screen.findByTestId('share-key-dialog')
    expect(account.remoteSetSharing).not.toHaveBeenCalled()

    await user.click(
      within(dialog).getByRole('button', { name: 'Create key and share' })
    )

    await waitFor(() =>
      expect(account.remoteSetSharing).toHaveBeenCalledWith(true)
    )
    expect(useLocalApiServer.getState().apiKey).toMatch(/^sk-atomic-/)
    expect(useLocalApiServer.getState().remoteAccessAutoStart).toBe(true)
    expect(server.settle).toHaveBeenCalledTimes(1)
    expect(server.startTunnel).toHaveBeenCalledTimes(1)
    expect(await screen.findByTestId('share-reach')).toHaveTextContent(
      'Reachable from anywhere'
    )
  })

  it('restarts a running server that was started without its key', async () => {
    useLocalApiServer.getState().setApiKey('sk-atomic-existing')
    useAppState.setState({ serverStatus: 'running' })
    server.servedWithKey = false
    await renderPage(signedIn, EMPTY_REMOTE_STATUS)

    await userEvent.setup().click(screen.getByTestId('share-switch'))

    await waitFor(() =>
      expect(account.remoteSetSharing).toHaveBeenCalledWith(true)
    )
    expect(screen.queryByTestId('share-key-dialog')).not.toBeInTheDocument()
    expect(server.restart).toHaveBeenCalledTimes(1)
    expect(server.settle).not.toHaveBeenCalled()
  })

  it('does not share when the server fails to start', async () => {
    useLocalApiServer.getState().setApiKey('sk-atomic-existing')
    server.settle.mockResolvedValueOnce(false)
    await renderPage(signedIn, EMPTY_REMOTE_STATUS)

    await userEvent.setup().click(screen.getByTestId('share-switch'))

    expect(
      await screen.findByText(
        "The local API server didn't start, so this computer can't share its models."
      )
    ).toBeInTheDocument()
    expect(account.remoteSetSharing).not.toHaveBeenCalled()
  })

  it('shows a request with its check code and allows it', async () => {
    await renderPage(signedIn, {
      ...sharing,
      requests: [
        {
          grantId: 'g1',
          deviceName: "Ann's iPhone",
          platform: 'ios',
          clientType: 'mobile',
          checkCode: '936468',
          createdAt: '2026-11-12T10:00:00Z',
        },
      ],
    })
    const row = screen.getByTestId('remote-request')
    expect(row).toHaveTextContent("Ann's iPhone")
    expect(row).toHaveTextContent('936468')

    await userEvent
      .setup()
      .click(within(row).getByRole('button', { name: 'Allow' }))

    expect(account.remoteDecide).toHaveBeenCalledWith('g1', true)
  })

  it('lists devices with access and revokes one', async () => {
    await renderPage(signedIn, {
      ...sharing,
      devices: [
        {
          grantId: 'g2',
          deviceName: 'Office PC',
          platform: 'windows',
          issuedAt: 1,
        },
      ],
    })

    await userEvent
      .setup()
      .click(
        screen.getByRole('button', { name: 'Revoke access for Office PC' })
      )

    expect(account.remoteRevoke).toHaveBeenCalledWith('g2')
    // The answer is the state after the revoke: the row is gone.
    expect(
      await screen.findByText('No device has access yet.')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('remote-device')).not.toBeInTheDocument()
  })

  it('opens a pairing code with its QR, and closes an unused code', async () => {
    await renderPage(signedIn, sharing)
    const user = userEvent.setup()

    await user.click(screen.getByTestId('add-device'))

    expect(await screen.findByTestId('pairing-code')).toHaveTextContent(
      'BCDF-GHJK'
    )
    expect(screen.getByTestId('pairing-qr').querySelector('svg')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(account.remoteClosePairingCode).toHaveBeenCalledTimes(1)
  })

  it('says when a device used the code', async () => {
    await renderPage(signedIn, sharing)
    await userEvent.setup().click(screen.getByTestId('add-device'))
    await screen.findByTestId('pairing-code')

    act(() => {
      useAccountRemoteStore.getState().setStatus({
        ...sharing,
        devices: [
          {
            grantId: 'g9',
            deviceName: "Ann's iPhone",
            platform: 'ios',
            issuedAt: 1,
          },
        ],
      })
    })

    expect(
      await screen.findByText(
        "Ann's iPhone can now use this computer's models."
      )
    ).toBeInTheDocument()
  })

  it('lists the other computers and asks one for access', async () => {
    await renderPage(signedIn, EMPTY_REMOTE_STATUS)

    const hosts = await screen.findAllByTestId('remote-host')
    expect(hosts).toHaveLength(1)
    expect(hosts[0]).toHaveTextContent('Studio Mac')

    await userEvent
      .setup()
      .click(within(hosts[0]).getByRole('button', { name: 'Connect' }))

    expect(account.remoteRequest).toHaveBeenCalledWith('host-studio')
  })

  it('refresh lists the computers and their models again, spinning meanwhile', async () => {
    let finish = () => {}
    remoteSync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    await renderPage(signedIn, EMPTY_REMOTE_STATUS)
    account.remoteHosts.mockClear()
    const button = screen.getByTestId('remote-refresh')

    await userEvent.setup().click(button)

    await waitFor(() =>
      expect(remoteSync).toHaveBeenCalledWith(
        [studioConnection],
        expect.anything(),
        { refreshModels: true }
      )
    )
    expect(account.remoteHosts).toHaveBeenCalledTimes(1)
    expect(button).toBeDisabled()
    expect(button.querySelector('svg')).toHaveClass('animate-spin')

    await act(async () => finish())

    await waitFor(() => expect(button).toBeEnabled())
    expect(button.querySelector('svg')).not.toHaveClass('animate-spin')
  })

  it('shows the check code to confirm on the host while a request waits', async () => {
    await renderPage(signedIn, {
      ...EMPTY_REMOTE_STATUS,
      connections: [
        {
          grantId: 'g-req',
          hostId: 'host-studio',
          hostName: 'Studio Mac',
          status: 'pending',
          ready: false,
          via: null,
          checkCode: '482915',
        },
      ],
    })

    expect(await screen.findByTestId('connection-waiting')).toHaveTextContent(
      'Allow it on Studio Mac: check code 482915'
    )
  })

  it('pairs with a typed code and explains a wrong one', async () => {
    await renderPage(signedIn, EMPTY_REMOTE_STATUS)
    const user = userEvent.setup()

    await user.type(screen.getByTestId('pair-code-input'), '  bcdf-ghjk ')
    await user.click(screen.getByRole('button', { name: 'Pair' }))
    expect(account.remotePair).toHaveBeenCalledWith('bcdf-ghjk')

    account.remotePair.mockRejectedValueOnce({
      code: 'invalid_code',
      message: 'invalid',
      attemptsLeft: null,
      retryAfter: null,
    })
    await user.type(screen.getByTestId('pair-code-input'), 'ZZZZ-ZZZZ')
    await user.click(screen.getByRole('button', { name: 'Pair' }))

    expect(
      await screen.findByText('This code is wrong, used or expired.')
    ).toBeInTheDocument()
  })
})
