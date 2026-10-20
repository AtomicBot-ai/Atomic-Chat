import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useRemoteAccessStore } from '@/hooks/useRemoteAccess'
import { seedServiceHub } from '@/test/service-hub'

const { control, capture } = vi.hoisted(() => ({
  control: {
    start: vi.fn(),
    stop: vi.fn(),
    toggle: vi.fn(),
    refreshStatus: vi.fn(),
  },
  capture: vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
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

import { ServerConfigurationPage } from '@/routes/settings/local-api-server'

const settings = () => useLocalApiServer.getState()
const field = (label: string) => screen.getByLabelText(label)
const saveButton = () =>
  screen.getByRole('button', { name: 'settings:serverConfig.save' })
const statusLine = () => screen.getByRole('status')
/** The save bar shows only with something to save or a restart to report. */
const noSaveBar = () =>
  screen.queryByRole('status') === null &&
  screen.queryByRole('button', { name: 'settings:serverConfig.discard' }) ===
    null
const edit = (label: string, value: string) =>
  fireEvent.change(field(label), { target: { value } })
/** Open the field's dropdown, which drops under it, and pick an option. */
const choose = async (label: string, option: string) => {
  const user = userEvent.setup()
  await user.click(field(label))
  await user.click(screen.getByRole('menuitemradio', { name: option }))
}

describe('Server → Configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useRemoteAccessStore.getState().reset()
    useAppState.setState({ serverStatus: 'stopped' })
    useLocalApiServer.setState({
      serverHost: '127.0.0.1',
      serverPort: 1337,
      apiPrefix: '/v1',
      apiKey: '',
      enableOnStartup: true,
      proxyTimeout: 600,
      trustedHosts: ['studio.local'],
    })
    control.start.mockImplementation(async () => {
      useAppState.getState().setServerStatus('running')
    })
    control.stop.mockImplementation(async () => {
      useAppState.getState().setServerStatus('stopped')
    })
    seedServiceHub()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the stored settings under the page title, with no save bar', () => {
    render(<ServerConfigurationPage />)

    expect(
      screen.getByRole('heading', { name: 'settings:serverConfig.title' })
    ).toBeInTheDocument()
    expect(field('settings:serverConfig.host')).toHaveTextContent(
      'settings:serverConfig.hostLocal'
    )
    expect(field('settings:serverConfig.port')).toHaveValue('1337')
    expect(field('settings:serverConfig.prefix')).toHaveValue('/v1')
    expect(field('settings:serverKey.label')).toHaveValue('')
    expect(field('settings:serverConfig.autoStart')).toBeChecked()
    expect(field('settings:serverConfig.timeout')).toHaveValue('600')
    expect(field('settings:serverConfig.trustedHosts')).toHaveValue(
      'studio.local'
    )
    expect(noSaveBar()).toBe(true)
  })

  it('keeps edits in a draft until Save, and Discard puts the stored values back', () => {
    render(<ServerConfigurationPage />)

    edit('settings:serverConfig.port', '8080')
    expect(statusLine()).toHaveTextContent('settings:serverConfig.unsaved')
    expect(settings().serverPort).toBe(1337)

    fireEvent.click(
      screen.getByRole('button', { name: 'settings:serverConfig.discard' })
    )
    expect(field('settings:serverConfig.port')).toHaveValue('1337')
    expect(noSaveBar()).toBe(true)
  })

  it('saves every field to the server store without touching a stopped server', async () => {
    render(<ServerConfigurationPage />)

    await choose(
      'settings:serverConfig.host',
      'settings:serverConfig.hostNetwork'
    )
    edit('settings:serverConfig.port', '8080')
    edit('settings:serverConfig.prefix', '/api/v2')
    edit('settings:serverKey.label', 'sk-typed')
    fireEvent.click(field('settings:serverConfig.autoStart'))
    edit('settings:serverConfig.timeout', '0')
    edit(
      'settings:serverConfig.trustedHosts',
      ' studio.local, lab.local,, studio.local '
    )
    fireEvent.click(saveButton())

    await waitFor(() => expect(noSaveBar()).toBe(true))
    expect(settings()).toMatchObject({
      serverHost: '0.0.0.0',
      serverPort: 8080,
      apiPrefix: '/api/v2',
      apiKey: 'sk-typed',
      enableOnStartup: false,
      proxyTimeout: 0,
      trustedHosts: ['studio.local', 'lab.local'],
    })
    expect(field('settings:serverConfig.trustedHosts')).toHaveValue(
      'studio.local, lab.local'
    )
    expect(control.stop).not.toHaveBeenCalled()
    expect(control.start).not.toHaveBeenCalled()
  })

  it('refuses a setting the server cannot use and says which', () => {
    render(<ServerConfigurationPage />)

    edit('settings:serverConfig.port', '70000')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'settings:serverConfig.invalid'
    )
    expect(saveButton()).toBeDisabled()

    edit('settings:serverConfig.port', '8080')
    edit('settings:serverConfig.prefix', 'v1')
    expect(saveButton()).toBeDisabled()

    edit('settings:serverConfig.prefix', '/v1')
    edit('settings:serverConfig.timeout', '86401')
    expect(saveButton()).toBeDisabled()
  })

  it('applies a new port to a running server with stop → start, not reloading a model', async () => {
    useAppState.setState({ serverStatus: 'running' })
    render(<ServerConfigurationPage />)

    edit('settings:serverConfig.port', '8080')
    // No "Apply & restart": saving applies the change.
    expect(saveButton()).toHaveTextContent('settings:serverConfig.save')
    fireEvent.click(saveButton())

    await waitFor(() => expect(noSaveBar()).toBe(true))
    expect(settings().serverPort).toBe(8080)
    // A restart is not a turn-off: the models stay loaded.
    expect(control.stop).toHaveBeenCalledTimes(1)
    expect(control.stop).toHaveBeenCalledWith({ keepModels: true })
    expect(control.start).toHaveBeenCalledWith({ ensureModel: false })
    expect(control.stop.mock.invocationCallOrder[0]).toBeLessThan(
      control.start.mock.invocationCallOrder[0]
    )
  })

  it('does not restart a running server for the autostart setting alone', async () => {
    useAppState.setState({ serverStatus: 'running' })
    render(<ServerConfigurationPage />)

    fireEvent.click(field('settings:serverConfig.autoStart'))
    fireEvent.click(saveButton())

    await waitFor(() => expect(noSaveBar()).toBe(true))
    expect(settings().enableOnStartup).toBe(false)
    expect(control.stop).not.toHaveBeenCalled()
  })

  it('says so when the server does not come back after the restart', async () => {
    useAppState.setState({ serverStatus: 'running' })
    control.start.mockImplementation(async () => {})
    render(<ServerConfigurationPage />)

    edit('settings:serverConfig.port', '8080')
    fireEvent.click(saveButton())

    await waitFor(() =>
      expect(statusLine()).toHaveTextContent(
        'settings:serverConfig.restartFailed'
      )
    )
    expect(settings().serverPort).toBe(8080)
  })

  it('follows a key generated elsewhere, but never over the user’s own edit', () => {
    render(<ServerConfigurationPage />)

    act(() => {
      useLocalApiServer.getState().setApiKey('sk-atomic-from-remote')
    })
    expect(field('settings:serverKey.label')).toHaveValue(
      'sk-atomic-from-remote'
    )

    edit('settings:serverConfig.port', '8080')
    act(() => {
      useLocalApiServer.getState().setServerPort(9090)
    })
    expect(field('settings:serverConfig.port')).toHaveValue('8080')
  })

  it('generates a key into the draft and counts where it came from', () => {
    render(<ServerConfigurationPage />)

    fireEvent.click(
      screen.getByRole('button', { name: 'settings:serverKey.generate' })
    )

    expect(
      (field('settings:serverKey.label') as HTMLInputElement).value
    ).toMatch(/^sk-atomic-[A-Za-z0-9_-]{32}$/)
    expect(settings().apiKey).toBe('')
    expect(capture).toHaveBeenCalledWith('local_api_key_generate', {
      generate_source: 'server_configuration',
    })
    expect(
      screen.getByRole('button', { name: 'settings:serverKey.show' })
    ).toBeInTheDocument()
  })
})
