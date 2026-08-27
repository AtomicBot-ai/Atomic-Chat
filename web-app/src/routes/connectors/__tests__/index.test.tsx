import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Route as ConnectorsRoute } from '../index'
import { useMCPServers, type MCPServerConfig } from '@/hooks/useMCPServers'

const activateMCPServer = vi.fn()
const deactivateMCPServer = vi.fn()
const getMCPServerStatuses = vi.fn()
const updateMCPConfig = vi.fn()

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
  default: () => null,
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
    seedServers({})
  })

  it('shows the empty state when nothing is connected', () => {
    render(<ConnectorsPage />)

    expect(
      screen.getByText('mcp-connectors:emptyState.title')
    ).toBeInTheDocument()
  })

  it('lists connected servers and hides the browser MCP entry', () => {
    seedServers({
      exa: { command: '', args: [], env: {}, type: 'http', url: 'https://x' },
      'Jan Browser MCP': { command: 'npx', args: [], env: {} },
    })
    render(<ConnectorsPage />)

    expect(screen.getByText('exa')).toBeInTheDocument()
    expect(screen.queryByText('Jan Browser MCP')).not.toBeInTheDocument()
  })

  it('renders every catalog connector', () => {
    render(<ConnectorsPage />)

    for (const name of [
      'Exa',
      'Fetch',
      'Filesystem',
      'Sequential Thinking',
      'Browser MCP',
      'Serper',
    ]) {
      expect(screen.getByText(name)).toBeInTheDocument()
    }
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

    const fetchCard = screen.getByText('Fetch').closest('div.bg-card')!
    await user.click(
      within(fetchCard as HTMLElement).getByRole('button', {
        name: 'mcp-connectors:setUp',
      })
    )

    await waitFor(() =>
      expect(useMCPServers.getState().mcpServers.fetch?.active).toBe(false)
    )
  })

  it('shows connector state instead of Set Up once installed', () => {
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

    const exaCard = screen.getAllByText('Exa')[0].closest('div.bg-card')!
    expect(
      within(exaCard as HTMLElement).queryByRole('button', {
        name: 'mcp-connectors:setUp',
      })
    ).not.toBeInTheDocument()
    expect(
      within(exaCard as HTMLElement).getByText('mcp-connectors:added')
    ).toBeInTheDocument()
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

  it('opens the custom MCP dialog from the manual section', async () => {
    const user = userEvent.setup()
    render(<ConnectorsPage />)

    await user.click(
      screen.getByRole('button', { name: /mcp-connectors:addCustom/ })
    )

    expect(screen.getByTestId('add-edit-dialog')).toBeInTheDocument()
  })

  it('switches to the logs tab', async () => {
    const user = userEvent.setup()
    render(<ConnectorsPage />)

    await user.click(screen.getByText('mcp-connectors:tabs.logs'))

    expect(screen.getByTestId('log-viewer')).toBeInTheDocument()
  })
})
