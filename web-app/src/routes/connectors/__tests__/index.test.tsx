import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Route as ConnectorsRoute } from '../index'
import { useMCPServers, type MCPServerConfig } from '@/hooks/useMCPServers'

const activateMCPServer = vi.fn()
const deactivateMCPServer = vi.fn()
const getMCPServerStatuses = vi.fn()
const updateMCPConfig = vi.fn()
const mcpOauthLogin = vi.fn()
const mcpOauthCancel = vi.fn()
const mcpOauthLogout = vi.fn()

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sonner')>()
  return {
    ...actual,
    toast: { ...actual.toast, error: toastError },
  }
})

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="header-page">{children}</div>
  ),
}))

vi.mock('@/components/MCPLogViewer', () => ({
  MCPLogViewer: () => <div data-testid="log-viewer" />,
}))

vi.mock('@/containers/dialogs/AddEditMCPServer', () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-edit-dialog" /> : null,
}))

vi.mock('@/containers/dialogs/EditJsonMCPserver', () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="json-editor-dialog" /> : null,
}))

vi.mock('@/containers/dialogs/DeleteMCPServerConfirm', () => ({
  default: () => null,
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars ? `${key}:${Object.values(vars).join(',')}` : key,
  }),
}))

const serviceHubMock = {
  mcp: () => ({
    activateMCPServer,
    deactivateMCPServer,
    getMCPServerStatuses,
    updateMCPConfig,
    mcpOauthLogin,
    mcpOauthCancel,
    mcpOauthLogout,
  }),
}

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => serviceHubMock,
  getServiceHub: () => serviceHubMock,
}))

vi.mock('@/hooks/useToolApproval', () => ({
  useToolApproval: () => ({
    allowAllMCPPermissions: true,
    setAllowAllMCPPermissions: vi.fn(),
  }),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}))

const ConnectorsPage = (
  ConnectorsRoute as unknown as { component: () => JSX.Element }
).component

const seedServers = (servers: Record<string, MCPServerConfig>) =>
  useMCPServers.setState({ mcpServers: servers })

describe('ConnectorsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getMCPServerStatuses.mockResolvedValue([])
    activateMCPServer.mockResolvedValue(undefined)
    deactivateMCPServer.mockResolvedValue(undefined)
    updateMCPConfig.mockResolvedValue(undefined)
    mcpOauthLogin.mockResolvedValue(undefined)
    mcpOauthCancel.mockResolvedValue(undefined)
    mcpOauthLogout.mockResolvedValue(undefined)
    seedServers({})
  })

  it('merges installed servers into the grid and hides the system defaults', () => {
    seedServers({
      exa: {
        command: '',
        args: [],
        env: {},
        type: 'http',
        url: 'https://mcp.exa.ai/mcp',
      },
      'my server': { command: 'npx', args: ['-y', 'some-mcp'], env: {} },
      'Jan Browser MCP': { command: 'npx', args: [], env: {} },
      filesystem: { command: 'npx', args: [], env: {} },
      'sequential-thinking': { command: 'npx', args: [], env: {} },
      browsermcp: { command: 'npx', args: [], env: {} },
    })
    render(<ConnectorsPage />)

    // The installed exa is one merged card, not a connected row plus a
    // catalog card.
    expect(screen.getAllByText('Exa')).toHaveLength(1)
    expect(screen.getByText('my server')).toBeInTheDocument()
    expect(screen.queryByText('Jan Browser MCP')).not.toBeInTheDocument()
    expect(screen.queryByText('filesystem')).not.toBeInTheDocument()
    expect(screen.queryByText('sequential-thinking')).not.toBeInTheDocument()
    expect(screen.queryByText('browsermcp')).not.toBeInTheDocument()
  })

  it('renders every catalog connector', () => {
    render(<ConnectorsPage />)

    for (const name of [
      'Exa',
      'GitHub',
      'Linear',
      'Notion',
      'Sentry',
      'Atlassian',
      'Serper',
    ]) {
      expect(screen.getByText(name)).toBeInTheDocument()
    }
  })

  it('keeps oauth-soon connectors as a disabled sign-in, never installing them', async () => {
    render(<ConnectorsPage />)

    const githubCard = screen.getByText('GitHub').closest('div.bg-card')!
    const signIn = within(githubCard as HTMLElement).getByRole('button', {
      name: 'mcp-connectors:oauth.signIn',
    })
    expect(signIn).toBeDisabled()
    expect(
      within(githubCard as HTMLElement).queryByRole('button', {
        name: 'mcp-connectors:setUp',
      })
    ).not.toBeInTheDocument()
    expect(activateMCPServer).not.toHaveBeenCalled()
  })

  it('signs an oauth connector in via the browser, then installs it', async () => {
    const user = userEvent.setup()
    render(<ConnectorsPage />)

    const linearCard = screen.getByText('Linear').closest('div.bg-card')!
    await user.click(
      within(linearCard as HTMLElement).getByRole('button', {
        name: 'mcp-connectors:oauth.signIn',
      })
    )

    await waitFor(() =>
      expect(mcpOauthLogin).toHaveBeenCalledWith(
        'linear',
        'https://mcp.linear.app/mcp'
      )
    )
    await waitFor(() =>
      expect(activateMCPServer).toHaveBeenCalledWith(
        'linear',
        expect.objectContaining({ type: 'http', active: true })
      )
    )
    expect(useMCPServers.getState().mcpServers.linear.active).toBe(true)
  })

  it('surfaces a failed browser sign-in and never installs the server', async () => {
    const user = userEvent.setup()
    mcpOauthLogin.mockRejectedValue(
      new Error('linear: authorization discovery failed')
    )
    render(<ConnectorsPage />)

    const linearCard = screen.getByText('Linear').closest('div.bg-card')!
    await user.click(
      within(linearCard as HTMLElement).getByRole('button', {
        name: 'mcp-connectors:oauth.signIn',
      })
    )

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'mcp-connectors:oauth.failed',
        expect.objectContaining({
          description: 'linear: authorization discovery failed',
        })
      )
    )
    expect(activateMCPServer).not.toHaveBeenCalled()
    expect(useMCPServers.getState().mcpServers.linear).toBeUndefined()
  })

  it('stays quiet when the user cancels the browser sign-in', async () => {
    const user = userEvent.setup()
    mcpOauthLogin.mockRejectedValue(new Error('sign-in cancelled'))
    render(<ConnectorsPage />)

    const linearCard = screen.getByText('Linear').closest('div.bg-card')!
    await user.click(
      within(linearCard as HTMLElement).getByRole('button', {
        name: 'mcp-connectors:oauth.signIn',
      })
    )

    await waitFor(() => expect(mcpOauthLogin).toHaveBeenCalled())
    expect(toastError).not.toHaveBeenCalled()
    expect(activateMCPServer).not.toHaveBeenCalled()
  })

  it('installs a keyless connector in one click', async () => {
    const user = userEvent.setup()
    render(<ConnectorsPage />)

    const exaCard = screen.getByText('Exa').closest('div.bg-card')!
    await user.click(
      within(exaCard as HTMLElement).getByRole('button', {
        name: 'mcp-connectors:setUp',
      })
    )

    await waitFor(() =>
      expect(activateMCPServer).toHaveBeenCalledWith(
        'exa',
        expect.objectContaining({
          type: 'http',
          url: 'https://mcp.exa.ai/mcp',
          active: true,
        })
      )
    )
    expect(updateMCPConfig).toHaveBeenCalled()
    expect(useMCPServers.getState().mcpServers.exa.active).toBe(true)
  })

  it('leaves the server deactivated when activation fails', async () => {
    const user = userEvent.setup()
    activateMCPServer.mockRejectedValue(new Error('spawn failed'))
    render(<ConnectorsPage />)

    const exaCard = screen.getByText('Exa').closest('div.bg-card')!
    await user.click(
      within(exaCard as HTMLElement).getByRole('button', {
        name: 'mcp-connectors:setUp',
      })
    )

    await waitFor(() =>
      expect(useMCPServers.getState().mcpServers.exa?.active).toBe(false)
    )
  })

  it('shows a toggle instead of Set Up once installed', () => {
    seedServers({
      exa: {
        command: '',
        args: [],
        env: {},
        type: 'http',
        url: 'https://mcp.exa.ai/mcp',
        active: true,
      },
    })
    render(<ConnectorsPage />)

    const exaCard = screen.getByText('Exa').closest('div.bg-card')!
    expect(
      within(exaCard as HTMLElement).queryByRole('button', {
        name: 'mcp-connectors:setUp',
      })
    ).not.toBeInTheDocument()
    expect(
      within(exaCard as HTMLElement).getByRole('switch')
    ).toBeInTheDocument()
  })

  it('toggles an installed server off from its card', async () => {
    const user = userEvent.setup()
    seedServers({
      exa: {
        command: '',
        args: [],
        env: {},
        type: 'http',
        url: 'https://mcp.exa.ai/mcp',
        active: true,
      },
    })
    render(<ConnectorsPage />)

    const exaCard = screen.getByText('Exa').closest('div.bg-card')!
    await user.click(within(exaCard as HTMLElement).getByRole('switch'))

    await waitFor(() =>
      expect(deactivateMCPServer).toHaveBeenCalledWith('exa')
    )
    expect(useMCPServers.getState().mcpServers.exa.active).toBe(false)
  })

  it('asks for a key before installing a secret connector', async () => {
    const user = userEvent.setup()
    render(<ConnectorsPage />)

    const serperCard = screen.getByText('Serper').closest('div.bg-card')!
    await user.click(
      within(serperCard as HTMLElement).getByRole('button', {
        name: 'mcp-connectors:setUp',
      })
    )

    const connect = await screen.findByRole('button', {
      name: 'mcp-connectors:secretDialog.connect',
    })
    expect(connect).toBeDisabled()
    expect(activateMCPServer).not.toHaveBeenCalled()

    await user.type(
      screen.getByPlaceholderText('sk-...'),
      'my-serper-key'
    )
    await user.click(connect)

    await waitFor(() =>
      expect(activateMCPServer).toHaveBeenCalledWith(
        'serper',
        expect.objectContaining({
          env: { SERPER_API_KEY: 'my-serper-key' },
          active: true,
        })
      )
    )
  })

  it('opens the custom MCP dialog from the header action', async () => {
    const user = userEvent.setup()
    render(<ConnectorsPage />)

    await user.click(
      screen.getByRole('button', { name: /mcp-connectors:addServer/ })
    )

    expect(screen.getByTestId('add-edit-dialog')).toBeInTheDocument()
  })

  it('opens the bulk JSON editor from the header action', async () => {
    const user = userEvent.setup()
    render(<ConnectorsPage />)

    expect(screen.queryByTestId('json-editor-dialog')).not.toBeInTheDocument()
    await user.click(
      screen.getByRole('button', { name: /mcp-connectors:importConfig/ })
    )

    expect(screen.getByTestId('json-editor-dialog')).toBeInTheDocument()
  })

  it('expands the logs section from the bottom button', async () => {
    const user = userEvent.setup()
    render(<ConnectorsPage />)

    expect(screen.queryByTestId('log-viewer')).not.toBeInTheDocument()
    await user.click(
      screen.getByRole('button', { name: /mcp-connectors:logs.show/ })
    )

    expect(screen.getByTestId('log-viewer')).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: /mcp-connectors:logs.hide/ })
    )
    expect(screen.queryByTestId('log-viewer')).not.toBeInTheDocument()
  })
})
