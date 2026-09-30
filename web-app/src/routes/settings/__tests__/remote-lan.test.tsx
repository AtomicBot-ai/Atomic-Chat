import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppState } from '@/hooks/useAppState'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useRemoteAccessStore } from '@/hooks/useRemoteAccess'
import { seedServiceHub } from '@/test/service-hub'
import type { RemoteAccessStatus } from '@/types/remoteAccess'

const { control, capture, toastSuccess, features } = vi.hoisted(() => ({
  control: {
    start: vi.fn(),
    stop: vi.fn(),
    toggle: vi.fn(),
    refreshStatus: vi.fn(),
  },
  capture: vi.fn(),
  toastSuccess: vi.fn(),
  features: { localApiServer: true } as Record<string, boolean>,
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  redirect: (options: Record<string, unknown>) =>
    Object.assign(new Error('redirect'), { redirect: options }),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/containers/SettingsMenu', () => ({
  default: () => <nav data-testid="settings-menu" />,
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <header>{children}</header>
  ),
}))

// The real hook loads models and talks to the proxy. This stand-in keeps its
// contract: `status` follows the app state, which `start`/`stop` move.
vi.mock('@/hooks/useLocalApiServerControl', async () => {
  const { useAppState: appState } = await import('@/hooks/useAppState')
  return {
    useLocalApiServerControl: () => {
      const status = appState((state) => state.serverStatus)
      return {
        status,
        isRunning: status !== 'stopped',
        isModelLoading: false,
        isBusy: status === 'pending',
        ...control,
      }
    },
  }
})

vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: capture }))

vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/platform/const', () => ({ PlatformFeatures: features }))

import { RemoteLanPage, Route } from '../remote-lan'

const OFF: RemoteAccessStatus = {
  state: 'off',
  url: null,
  error: null,
  blockReason: null,
  canStart: true,
  canStop: false,
  serverHasApiKey: false,
}

const SERVER_STOPPED: RemoteAccessStatus = {
  ...OFF,
  blockReason: 'server_stopped',
  canStart: false,
}

const STARTING: RemoteAccessStatus = {
  ...OFF,
  state: 'starting',
  canStart: false,
  canStop: true,
}

const ONLINE: RemoteAccessStatus = {
  ...STARTING,
  state: 'online',
  url: 'https://quiet-river.trycloudflare.com',
}

const KEY = 'sk-atomic-0123456789abcdefghijklmnopqrstuv'

const app = {
  getRemoteAccessStatus: vi.fn(),
  startRemoteAccess: vi.fn(),
  stopRemoteAccess: vi.fn(),
  getLanAddresses: vi.fn(),
}

const writeText = vi.fn()

const tunnel = () => useRemoteAccessStore.getState()
const settings = () => useLocalApiServer.getState()
const remoteCard = () =>
  screen.getByRole('region', { name: 'settings:remoteLan.remote.title' })
const lanCard = () =>
  screen.getByRole('region', { name: 'settings:remoteLan.lan.title' })
const button = (card: HTMLElement, name: string) =>
  within(card).getByRole('button', { name })
const eventsNamed = (name: string) =>
  capture.mock.calls.filter(([event]) => event === name).map(([, props]) => props)

/** Renders the page and waits for the first tunnel status to land. */
async function renderPage(status: RemoteAccessStatus) {
  app.getRemoteAccessStatus.mockResolvedValue(status)
  render(<RemoteLanPage />)
  await waitFor(() => expect(tunnel().status).toEqual(status))
}

describe('Settings → Remote & LAN', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    features.localApiServer = true
    localStorage.clear()
    tunnel().reset()
    useAppState.setState({ serverStatus: 'stopped' })
    useGeneralSetting.setState({ remoteLanBadgeSeen: false })
    useLocalApiServer.setState({
      apiKey: '',
      apiPrefix: '/v1',
      serverHost: '127.0.0.1',
      serverPort: 1337,
      enableOnStartup: true,
      remoteAccessAutoStart: false,
      exposeWithoutKeyAcknowledged: false,
    })

    control.start.mockImplementation(async () => {
      useAppState.getState().setServerStatus('running')
    })
    control.stop.mockImplementation(async () => {
      useAppState.getState().setServerStatus('stopped')
    })
    app.startRemoteAccess.mockResolvedValue(STARTING)
    app.stopRemoteAccess.mockResolvedValue(OFF)
    app.getLanAddresses.mockResolvedValue(['192.168.1.20', '10.0.0.7'])
    seedServiceHub({ app: app as never })

    writeText.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
  })

  // The shared teardown clears the service hub before it unmounts; unmount
  // first so the page does not re-render without one.
  afterEach(() => {
    cleanup()
  })

  it('renders both cards, off, inside the settings chrome', async () => {
    await renderPage(SERVER_STOPPED)

    expect(screen.getByText('common:settings')).toBeInTheDocument()
    expect(screen.getByTestId('settings-menu')).toBeInTheDocument()

    const remote = remoteCard()
    expect(within(remote).getByRole('status')).toHaveTextContent(
      'settings:remoteLan.state.off'
    )
    expect(
      within(remote).getByText('settings:remoteLan.remote.description')
    ).toBeInTheDocument()
    // A stopped server does not grey Start out: the page starts it first.
    expect(button(remote, 'settings:remoteLan.start')).toBeEnabled()
    expect(
      within(remote).getByText('settings:remoteLan.remote.block.serverStopped')
    ).toBeInTheDocument()
    expect(
      within(remote).getByText('settings:remoteLan.apiKey.title')
    ).toBeInTheDocument()

    const lan = lanCard()
    expect(within(lan).getByRole('status')).toHaveTextContent(
      'settings:remoteLan.state.off'
    )
    expect(button(lan, 'settings:remoteLan.start')).toBeEnabled()
    expect(
      within(lan).getByText('settings:remoteLan.lan.block.serverStopped')
    ).toBeInTheDocument()
  })

  it('clears the "New" pill on the first visit', async () => {
    await renderPage(OFF)

    expect(useGeneralSetting.getState().remoteLanBadgeSeen).toBe(true)
  })

  it('reports a backend without the tunnel instead of offering a dead button', async () => {
    app.getRemoteAccessStatus.mockRejectedValue(
      'Command get_remote_access_status not found'
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    render(<RemoteLanPage />)

    const remote = remoteCard()
    expect(
      await within(remote).findByText('settings:remoteLan.remote.unavailable')
    ).toBeInTheDocument()
    expect(within(remote).getByRole('status')).toHaveTextContent(
      'settings:remoteLan.state.unavailable'
    )
    expect(button(remote, 'settings:remoteLan.start')).toBeDisabled()
    warn.mockRestore()
  })

  describe('starting remote access', () => {
    it('asks before exposing the API without a key', async () => {
      await renderPage(SERVER_STOPPED)

      fireEvent.click(button(remoteCard(), 'settings:remoteLan.start'))

      const dialog = await screen.findByRole('dialog')
      expect(
        within(dialog).getByText('settings:remoteLan.noKeyDialog.title')
      ).toBeInTheDocument()
      expect(
        within(dialog).getByText('settings:remoteLan.noKeyDialog.description')
      ).toBeInTheDocument()
      expect(control.start).not.toHaveBeenCalled()
      expect(app.startRemoteAccess).not.toHaveBeenCalled()
    })

    it('"Generate key and start" saves a key, starts the server, then the tunnel', async () => {
      await renderPage(SERVER_STOPPED)
      fireEvent.click(button(remoteCard(), 'settings:remoteLan.start'))
      const dialog = await screen.findByRole('dialog')

      fireEvent.click(
        within(dialog).getByRole('button', {
          name: 'settings:remoteLan.noKeyDialog.generateAndStart',
        })
      )

      await waitFor(() =>
        expect(within(remoteCard()).getByRole('status')).toHaveTextContent(
          'settings:remoteLan.state.starting'
        )
      )
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(settings().apiKey).toMatch(/^sk-atomic-[A-Za-z0-9_-]{32}$/)
      // The key is in the mounted field, ready to be copied.
      expect(screen.getByPlaceholderText('common:enterApiKey')).toHaveValue(
        settings().apiKey
      )
      expect(control.start).toHaveBeenCalledTimes(1)
      expect(control.stop).not.toHaveBeenCalled()
      expect(app.startRemoteAccess).toHaveBeenCalledTimes(1)
      expect(control.start.mock.invocationCallOrder[0]).toBeLessThan(
        app.startRemoteAccess.mock.invocationCallOrder[0]
      )
      expect(eventsNamed('remote_access_no_key_choice')).toEqual([
        { choice: 'generate' },
      ])
      expect(eventsNamed('local_api_key_generate')).toEqual([
        { generate_source: 'remote_lan' },
      ])
      expect(eventsNamed('remote_access_start')).toEqual([
        { trigger_source: 'manual', start_result: 'started' },
      ])
    })

    it('"Generate key and start" restarts a running server so the key applies', async () => {
      useAppState.setState({ serverStatus: 'running' })
      await renderPage(OFF)
      fireEvent.click(button(remoteCard(), 'settings:remoteLan.start'))
      const dialog = await screen.findByRole('dialog')

      fireEvent.click(
        within(dialog).getByRole('button', {
          name: 'settings:remoteLan.noKeyDialog.generateAndStart',
        })
      )

      await waitFor(() =>
        expect(app.startRemoteAccess).toHaveBeenCalledTimes(1)
      )
      expect(settings().apiKey).toMatch(/^sk-atomic-[A-Za-z0-9_-]{32}$/)
      expect(control.start).toHaveBeenCalledWith({ ensureModel: false })
      const [stopped] = control.stop.mock.invocationCallOrder
      const [restarted] = control.start.mock.invocationCallOrder
      const [tunnelAsked] = app.startRemoteAccess.mock.invocationCallOrder
      expect(stopped).toBeLessThan(restarted)
      expect(restarted).toBeLessThan(tunnelAsked)
    })

    it('"Start without key" remembers the choice and starts', async () => {
      useAppState.setState({ serverStatus: 'running' })
      await renderPage(OFF)
      fireEvent.click(button(remoteCard(), 'settings:remoteLan.start'))
      const dialog = await screen.findByRole('dialog')

      fireEvent.click(
        within(dialog).getByRole('button', {
          name: 'settings:remoteLan.noKeyDialog.startWithoutKey',
        })
      )

      await waitFor(() =>
        expect(within(remoteCard()).getByRole('status')).toHaveTextContent(
          'settings:remoteLan.state.starting'
        )
      )
      expect(settings().exposeWithoutKeyAcknowledged).toBe(true)
      expect(settings().apiKey).toBe('')
      expect(app.startRemoteAccess).toHaveBeenCalledTimes(1)
      // The server was already up: nothing to start or restart.
      expect(control.start).not.toHaveBeenCalled()
      expect(control.stop).not.toHaveBeenCalled()
      expect(eventsNamed('remote_access_no_key_choice')).toEqual([
        { choice: 'without_key' },
      ])
    })

    it('does not ask again once that choice was made', async () => {
      useAppState.setState({ serverStatus: 'running' })
      useLocalApiServer.setState({ exposeWithoutKeyAcknowledged: true })
      await renderPage(OFF)

      fireEvent.click(button(remoteCard(), 'settings:remoteLan.start'))

      await waitFor(() =>
        expect(app.startRemoteAccess).toHaveBeenCalledTimes(1)
      )
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('cancelling starts nothing and changes nothing', async () => {
      await renderPage(SERVER_STOPPED)
      fireEvent.click(button(remoteCard(), 'settings:remoteLan.start'))
      const dialog = await screen.findByRole('dialog')

      fireEvent.click(
        within(dialog).getByRole('button', {
          name: 'settings:remoteLan.noKeyDialog.cancel',
        })
      )

      await waitFor(() =>
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      )
      expect(settings().apiKey).toBe('')
      expect(settings().exposeWithoutKeyAcknowledged).toBe(false)
      expect(control.start).not.toHaveBeenCalled()
      expect(app.startRemoteAccess).not.toHaveBeenCalled()
      expect(eventsNamed('remote_access_no_key_choice')).toEqual([
        { choice: 'cancel' },
      ])
    })

    it('starts straight away when a key is set', async () => {
      useLocalApiServer.setState({ apiKey: KEY })
      await renderPage(SERVER_STOPPED)

      fireEvent.click(button(remoteCard(), 'settings:remoteLan.start'))

      await waitFor(() =>
        expect(within(remoteCard()).getByRole('status')).toHaveTextContent(
          'settings:remoteLan.state.starting'
        )
      )
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(control.start).toHaveBeenCalledTimes(1)
      expect(control.start.mock.invocationCallOrder[0]).toBeLessThan(
        app.startRemoteAccess.mock.invocationCallOrder[0]
      )
      // While the tunnel comes up the same button calls it off.
      expect(button(remoteCard(), 'settings:remoteLan.stop')).toBeEnabled()
    })

    it('gives up, and says so, when the server does not come up', async () => {
      useLocalApiServer.setState({ apiKey: KEY })
      // What the real hook does with no model to load: it reports the failure
      // itself and leaves the status on `pending`.
      control.start.mockImplementation(async () => {
        useAppState.getState().setServerStatus('pending')
      })
      await renderPage(SERVER_STOPPED)

      fireEvent.click(button(remoteCard(), 'settings:remoteLan.start'))

      await waitFor(() => expect(control.start).toHaveBeenCalledTimes(1))
      // One failed click must not lock the page: both cards stay usable.
      await waitFor(() =>
        expect(button(remoteCard(), 'settings:remoteLan.start')).toBeEnabled()
      )
      expect(button(lanCard(), 'settings:remoteLan.start')).toBeEnabled()
      expect(useAppState.getState().serverStatus).toBe('stopped')
      expect(app.startRemoteAccess).not.toHaveBeenCalled()
      expect(within(remoteCard()).getByRole('status')).toHaveTextContent(
        'settings:remoteLan.state.off'
      )
      expect(eventsNamed('remote_access_start')).toEqual([
        {
          trigger_source: 'manual',
          start_result: 'blocked',
          block_reason: 'server_stopped',
        },
      ])
    })

    it('shows in red why a start was refused', async () => {
      useAppState.setState({ serverStatus: 'running' })
      useLocalApiServer.setState({ apiKey: KEY })
      app.startRemoteAccess.mockRejectedValue('cloudflared_unavailable')
      await renderPage({ ...OFF, serverHasApiKey: true })

      fireEvent.click(button(remoteCard(), 'settings:remoteLan.start'))

      const line = await within(remoteCard()).findByRole('alert')
      expect(line).toHaveTextContent(
        'settings:remoteLan.remote.error.cloudflared_unavailable'
      )
      expect(line).toHaveClass('text-destructive')
      expect(within(remoteCard()).getByRole('status')).toHaveTextContent(
        'settings:remoteLan.state.off'
      )
      expect(button(remoteCard(), 'settings:remoteLan.start')).toBeEnabled()
    })
  })

  describe('while remote access is online', () => {
    beforeEach(() => {
      useAppState.setState({ serverStatus: 'running' })
      useLocalApiServer.setState({ apiKey: KEY })
    })

    it('shows the base URL with the API prefix once the event says online', async () => {
      await renderPage({ ...STARTING, serverHasApiKey: true })
      expect(
        screen.queryByText('settings:remoteLan.remote.urlLabel')
      ).not.toBeInTheDocument()

      act(() => {
        tunnel().applyStatus({ ...ONLINE, serverHasApiKey: true }, 'event')
      })

      const remote = remoteCard()
      expect(within(remote).getByRole('status')).toHaveTextContent(
        'settings:remoteLan.state.online'
      )
      expect(
        within(remote).getByText('https://quiet-river.trycloudflare.com/v1')
      ).toBeInTheDocument()
      expect(
        within(remote).getByText('settings:remoteLan.remote.security')
      ).toBeInTheDocument()
      expect(
        within(remote).getByText('settings:remoteLan.remote.providerHint')
      ).toBeInTheDocument()
      // Keyed and healthy: nothing to warn about.
      expect(
        within(remote).queryByText('settings:remoteLan.noKeyWarning')
      ).not.toBeInTheDocument()
    })

    it('warns in amber while no key is in effect', async () => {
      useLocalApiServer.setState({
        apiKey: '',
        exposeWithoutKeyAcknowledged: true,
      })
      await renderPage(ONLINE)

      const warning = within(remoteCard()).getByText(
        'settings:remoteLan.noKeyWarning'
      )
      expect(warning).toHaveClass('text-amber-600')
    })

    it('copies the URL, and tells telemetry only that a remote URL was copied', async () => {
      await renderPage({ ...ONLINE, serverHasApiKey: true })
      const row = within(remoteCard()).getByRole('group', {
        name: 'https://quiet-river.trycloudflare.com/v1',
      })

      fireEvent.click(
        within(row).getByRole('button', { name: 'settings:remoteLan.copyUrl' })
      )

      await waitFor(() =>
        expect(eventsNamed('access_url_copy')).toEqual([
          { access_kind: 'remote' },
        ])
      )
      expect(writeText).toHaveBeenCalledWith(
        'https://quiet-river.trycloudflare.com/v1'
      )
      expect(JSON.stringify(capture.mock.calls)).not.toContain('trycloudflare')
    })

    it('opens a QR code for the URL on a white plate', async () => {
      await renderPage({ ...ONLINE, serverHasApiKey: true })

      fireEvent.click(
        button(remoteCard(), 'settings:remoteLan.qr.show')
      )

      const dialog = await screen.findByRole('dialog')
      const plate = within(dialog).getByTestId('access-qr-code')
      expect(plate.querySelector('svg')).not.toBeNull()
      expect(plate).toHaveClass('bg-white')
      expect(
        within(dialog).getByText('https://quiet-river.trycloudflare.com/v1')
      ).toBeInTheDocument()
      expect(
        within(dialog).getByText('settings:remoteLan.qr.remoteDesc')
      ).toBeInTheDocument()
      expect(eventsNamed('access_qr_open')).toEqual([{ access_kind: 'remote' }])
    })

    it('stops the tunnel from the same button', async () => {
      await renderPage({ ...ONLINE, serverHasApiKey: true })

      fireEvent.click(button(remoteCard(), 'settings:remoteLan.stop'))

      await waitFor(() =>
        expect(within(remoteCard()).getByRole('status')).toHaveTextContent(
          'settings:remoteLan.state.off'
        )
      )
      expect(app.stopRemoteAccess).toHaveBeenCalledTimes(1)
      expect(
        screen.queryByText('https://quiet-river.trycloudflare.com/v1')
      ).not.toBeInTheDocument()
    })

    it('offers the restart that applies a key, and brings the tunnel back after it', async () => {
      // The server was started without a key; one was saved since.
      await renderPage(ONLINE)
      control.stop.mockImplementation(async () => {
        useAppState.getState().setServerStatus('stopped')
        // Rust drops the tunnel together with the server.
        tunnel().applyStatus(SERVER_STOPPED, 'event')
      })
      app.getRemoteAccessStatus.mockResolvedValue({
        ...OFF,
        serverHasApiKey: true,
      })
      app.startRemoteAccess.mockResolvedValue({
        ...STARTING,
        serverHasApiKey: true,
      })

      const remote = remoteCard()
      expect(
        within(remote).getByText('settings:remoteLan.apiKey.restartToApply')
      ).toBeInTheDocument()
      // Until then the key protects nothing, whatever the field says.
      expect(
        within(remote).getByText('settings:remoteLan.noKeyWarning')
      ).toBeInTheDocument()

      fireEvent.click(button(remote, 'settings:remoteLan.apiKey.restartServer'))

      await waitFor(() =>
        expect(within(remoteCard()).getByRole('status')).toHaveTextContent(
          'settings:remoteLan.state.starting'
        )
      )
      expect(control.start).toHaveBeenCalledWith({ ensureModel: false })
      expect(control.stop.mock.invocationCallOrder[0]).toBeLessThan(
        control.start.mock.invocationCallOrder[0]
      )
      expect(eventsNamed('remote_access_start')).toEqual([
        { trigger_source: 'restore', start_result: 'started' },
      ])
      expect(
        within(remoteCard()).queryByText(
          'settings:remoteLan.apiKey.restartToApply'
        )
      ).not.toBeInTheDocument()
    })
  })

  describe('API key row', () => {
    it('generates a key into the mounted field and offers to copy it', async () => {
      await renderPage(SERVER_STOPPED)
      const remote = remoteCard()
      expect(
        within(remote).queryByRole('button', {
          name: 'settings:remoteLan.apiKey.copy',
        })
      ).not.toBeInTheDocument()

      fireEvent.click(button(remote, 'settings:remoteLan.apiKey.generate'))

      expect(settings().apiKey).toMatch(/^sk-atomic-[A-Za-z0-9_-]{32}$/)
      expect(screen.getByPlaceholderText('common:enterApiKey')).toHaveValue(
        settings().apiKey
      )
      expect(toastSuccess).toHaveBeenCalledWith(
        'settings:remoteLan.apiKey.generated'
      )

      fireEvent.click(button(remote, 'settings:remoteLan.apiKey.copy'))
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith(settings().apiKey)
      )
    })

    it('stays editable while the server runs, and asks for a restart after a change', async () => {
      useAppState.setState({ serverStatus: 'running' })
      useLocalApiServer.setState({ apiKey: KEY })
      await renderPage({ ...OFF, serverHasApiKey: true })
      const field = screen.getByPlaceholderText('common:enterApiKey')
      expect(field).not.toHaveClass('pointer-events-none')
      expect(
        screen.queryByText('settings:remoteLan.apiKey.restartToApply')
      ).not.toBeInTheDocument()

      fireEvent.change(field, { target: { value: 'sk-another-key' } })
      fireEvent.blur(field)

      expect(settings().apiKey).toBe('sk-another-key')
      expect(
        await screen.findByText('settings:remoteLan.apiKey.restartToApply')
      ).toBeInTheDocument()
    })
  })

  it('binds "Start automatically" to remoteAccessAutoStart', async () => {
    await renderPage(OFF)
    const toggle = within(remoteCard()).getByRole('switch', {
      name: 'settings:remoteLan.autoStart',
    })
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(toggle)

    expect(settings().remoteAccessAutoStart).toBe(true)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(eventsNamed('remote_access_auto_start_toggle')).toEqual([
      { enabled: true },
    ])
    // The LAN card's switch is a different setting.
    expect(settings().enableOnStartup).toBe(true)
  })

  describe('LAN access', () => {
    it('Start moves a running server onto the network: host first, then stop → start', async () => {
      useAppState.setState({ serverStatus: 'running' })
      useLocalApiServer.setState({ apiKey: KEY })
      let hostAtRestart: string | undefined
      control.start.mockImplementation(async () => {
        hostAtRestart = settings().serverHost
        useAppState.getState().setServerStatus('running')
      })
      await renderPage({ ...OFF, serverHasApiKey: true })
      const lan = lanCard()
      expect(
        within(lan).getByText('settings:remoteLan.lan.block.loopbackOnly')
      ).toBeInTheDocument()
      expect(
        within(lan).getByText('settings:remoteLan.lan.restartNote')
      ).toBeInTheDocument()
      expect(screen.queryByText('http://192.168.1.20:1337/v1')).toBeNull()

      fireEvent.click(button(lan, 'settings:remoteLan.start'))

      await waitFor(() =>
        expect(within(lanCard()).getByRole('status')).toHaveTextContent(
          'settings:remoteLan.state.online'
        )
      )
      expect(settings().serverHost).toBe('0.0.0.0')
      expect(hostAtRestart).toBe('0.0.0.0')
      expect(control.start).toHaveBeenCalledWith({ ensureModel: false })
      expect(control.stop.mock.invocationCallOrder[0]).toBeLessThan(
        control.start.mock.invocationCallOrder[0]
      )
      expect(
        await within(lanCard()).findByText('http://192.168.1.20:1337/v1')
      ).toBeInTheDocument()
      expect(
        within(lanCard()).getByText('http://10.0.0.7:1337/v1')
      ).toBeInTheDocument()
      expect(
        within(lanCard()).getByText('settings:remoteLan.lan.addressesLabel')
      ).toBeInTheDocument()
      expect(button(lanCard(), 'settings:remoteLan.stop')).toBeEnabled()
      expect(eventsNamed('lan_access_toggle')).toEqual([
        {
          lan_action: 'start',
          lan_result: 'online',
          server_was_running: true,
        },
      ])
      // Addresses identify the machine: none may reach telemetry.
      expect(JSON.stringify(capture.mock.calls)).not.toContain('192.168')
    })

    it('Start brings a stopped server up, loading a model if it has to', async () => {
      useLocalApiServer.setState({ apiKey: KEY })
      await renderPage(SERVER_STOPPED)

      fireEvent.click(button(lanCard(), 'settings:remoteLan.start'))

      await waitFor(() =>
        expect(within(lanCard()).getByRole('status')).toHaveTextContent(
          'settings:remoteLan.state.online'
        )
      )
      expect(settings().serverHost).toBe('0.0.0.0')
      expect(control.stop).not.toHaveBeenCalled()
      expect(control.start).toHaveBeenCalledWith()
      expect(eventsNamed('lan_access_toggle')).toEqual([
        {
          lan_action: 'start',
          lan_result: 'online',
          server_was_running: false,
        },
      ])
    })

    it('reports a start that failed, and stays usable', async () => {
      useLocalApiServer.setState({ apiKey: KEY })
      // The real hook leaves `pending` behind when it has no model to load.
      control.start.mockImplementation(async () => {
        useAppState.getState().setServerStatus('pending')
      })
      await renderPage(SERVER_STOPPED)

      fireEvent.click(button(lanCard(), 'settings:remoteLan.start'))

      await waitFor(() =>
        expect(eventsNamed('lan_access_toggle')).toEqual([
          {
            lan_action: 'start',
            lan_result: 'failed',
            server_was_running: false,
          },
        ])
      )
      expect(within(lanCard()).getByRole('status')).toHaveTextContent(
        'settings:remoteLan.state.off'
      )
      expect(button(lanCard(), 'settings:remoteLan.start')).toBeEnabled()
      expect(useAppState.getState().serverStatus).toBe('stopped')
    })

    it('Stop takes the server off the network and keeps it serving', async () => {
      useAppState.setState({ serverStatus: 'running' })
      useLocalApiServer.setState({ apiKey: KEY, serverHost: '0.0.0.0' })
      await renderPage({ ...OFF, serverHasApiKey: true })
      expect(
        await within(lanCard()).findByText('http://192.168.1.20:1337/v1')
      ).toBeInTheDocument()

      fireEvent.click(button(lanCard(), 'settings:remoteLan.stop'))

      await waitFor(() =>
        expect(within(lanCard()).getByRole('status')).toHaveTextContent(
          'settings:remoteLan.state.off'
        )
      )
      await waitFor(() => expect(control.start).toHaveBeenCalledTimes(1))
      expect(settings().serverHost).toBe('127.0.0.1')
      expect(control.start).toHaveBeenCalledWith({ ensureModel: false })
      expect(control.stop.mock.invocationCallOrder[0]).toBeLessThan(
        control.start.mock.invocationCallOrder[0]
      )
      expect(useAppState.getState().serverStatus).toBe('running')
      expect(screen.queryByText('http://192.168.1.20:1337/v1')).toBeNull()
      expect(
        await within(lanCard()).findByText(
          'settings:remoteLan.lan.block.loopbackOnly'
        )
      ).toBeInTheDocument()
      expect(eventsNamed('lan_access_toggle')).toEqual([
        { lan_action: 'stop', lan_result: 'off', server_was_running: true },
      ])
    })

    it('labels a single address in the singular, with copy and QR of its own', async () => {
      useAppState.setState({ serverStatus: 'running' })
      useLocalApiServer.setState({ apiKey: KEY, serverHost: '0.0.0.0' })
      app.getLanAddresses.mockResolvedValue(['192.168.1.20'])
      await renderPage({ ...OFF, serverHasApiKey: true })

      const row = await within(lanCard()).findByRole('group', {
        name: 'http://192.168.1.20:1337/v1',
      })
      expect(
        within(lanCard()).getByText('settings:remoteLan.lan.addressLabel')
      ).toBeInTheDocument()

      fireEvent.click(
        within(row).getByRole('button', { name: 'settings:remoteLan.copyUrl' })
      )
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith('http://192.168.1.20:1337/v1')
      )

      fireEvent.click(
        within(row).getByRole('button', { name: 'settings:remoteLan.qr.show' })
      )
      const dialog = await screen.findByRole('dialog')
      expect(
        within(dialog).getByTestId('access-qr-code').querySelector('svg')
      ).not.toBeNull()
      expect(
        within(dialog).getByText('settings:remoteLan.qr.lanDesc')
      ).toBeInTheDocument()
      expect(eventsNamed('access_url_copy')).toEqual([{ access_kind: 'lan' }])
      expect(eventsNamed('access_qr_open')).toEqual([{ access_kind: 'lan' }])
    })

    it('says so when LAN access is on but the machine has no address to share', async () => {
      useAppState.setState({ serverStatus: 'running' })
      useLocalApiServer.setState({ apiKey: KEY, serverHost: '0.0.0.0' })
      app.getLanAddresses.mockResolvedValue([])
      await renderPage({ ...OFF, serverHasApiKey: true })

      expect(
        await within(lanCard()).findByText(
          'settings:remoteLan.lan.block.noAddresses'
        )
      ).toBeInTheDocument()
      expect(within(lanCard()).getByRole('status')).toHaveTextContent(
        'settings:remoteLan.state.online'
      )
      expect(within(lanCard()).queryByRole('group')).not.toBeInTheDocument()
    })

    it('warns in amber, without a dialog, when LAN access is up with no key', async () => {
      useAppState.setState({ serverStatus: 'running' })
      useLocalApiServer.setState({ serverHost: '0.0.0.0' })
      await renderPage(OFF)

      const warning = await within(lanCard()).findByText(
        'settings:remoteLan.lan.noKeyWarning'
      )
      expect(warning).toHaveClass('text-amber-600')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('binds "Start automatically" to the server\'s own enableOnStartup', async () => {
      await renderPage(SERVER_STOPPED)
      const toggle = within(lanCard()).getByRole('switch', {
        name: 'settings:remoteLan.autoStart',
      })
      expect(toggle).toHaveAttribute('aria-checked', 'true')

      fireEvent.click(toggle)

      expect(settings().enableOnStartup).toBe(false)
      expect(toggle).toHaveAttribute('aria-checked', 'false')
      expect(settings().remoteAccessAutoStart).toBe(false)
    })
  })

  describe('beforeLoad', () => {
    const beforeLoad = () =>
      (Route as unknown as { beforeLoad: () => void }).beforeLoad()

    it('sends mobile and web to general settings', () => {
      features.localApiServer = false

      let thrown: unknown
      try {
        beforeLoad()
      } catch (error) {
        thrown = error
      }

      expect((thrown as { redirect: { to: string } }).redirect).toEqual({
        to: '/settings/general',
      })
    })

    it('lets desktop through', () => {
      expect(beforeLoad()).toBeUndefined()
    })
  })
})
