import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const activateMCPServer = vi.hoisted(() => vi.fn(async () => {}))
const deactivateMCPServer = vi.hoisted(() => vi.fn(async () => {}))
const updateMCPConfig = vi.hoisted(() => vi.fn(async () => {}))
const mcp = () => ({ activateMCPServer, deactivateMCPServer, updateMCPConfig })

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ mcp }),
  getServiceHub: () => ({ mcp }),
}))

vi.mock('@/hooks/useMCPServerStatuses', () => ({
  useMCPServerStatuses: () => ({
    statuses: [],
    statusByName: new Map(),
    refresh: vi.fn(),
  }),
}))

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: () => ({ getCurrentThread: () => ({ id: 'thread-1' }) }),
}))

// The dropdown lives in a radix portal that jsdom never opens; rendering the
// primitives inline lets the test read the rows the menu would show.
vi.mock('@/components/ui/dropdrawer', () => {
  type Props = {
    children?: React.ReactNode
    icon?: React.ReactNode
    onSelect?: (event: { preventDefault: () => void }) => void
  }
  const Passthrough = ({ children }: Props) => <div>{children}</div>
  return {
    DropDrawer: Passthrough,
    DropDrawerTrigger: Passthrough,
    DropDrawerContent: Passthrough,
    DropDrawerGroup: Passthrough,
    DropDrawerLabel: Passthrough,
    DropDrawerSeparator: () => <hr />,
    DropDrawerSub: Passthrough,
    DropDrawerSubTrigger: Passthrough,
    DropDrawerSubContent: Passthrough,
    DropDrawerItem: ({ children, icon, onSelect }: Props) => (
      <div>
        <button onClick={() => onSelect?.({ preventDefault: () => {} })}>
          {children}
        </button>
        {icon}
      </div>
    ),
  }
})

import DropdownConnectors from '../DropdownConnectors'
import { useAppState } from '@/hooks/useAppState'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import type { MCPTool } from '@/types/completion'

const tool = (server: string, name: string): MCPTool => ({
  server,
  name,
  description: `${name} description`,
  inputSchema: {},
})

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const renderDropdown = () =>
  render(
    <DropdownConnectors>
      {(_isOpen, active) => <button>connectors:{active}</button>}
    </DropdownConnectors>
  )

describe('DropdownConnectors', () => {
  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver as never
  })

  beforeEach(() => {
    vi.clearAllMocks()
    useAppState.setState({ tools: [] })
    useMCPServers.setState({ mcpServers: {} })
    useToolAvailable.setState({ disabledTools: {}, defaultDisabledTools: [] })
  })

  it('gives every configured server one switch, connected or not', () => {
    useMCPServers.setState({
      mcpServers: {
        exa: { command: '', args: [], env: {}, active: true },
        filesystem: { command: 'npx', args: [], env: {}, active: false },
      },
    })
    useAppState.setState({
      tools: [tool('exa', 'web_search_exa'), tool('exa', 'crawling_exa')],
    })

    renderDropdown()

    expect(screen.getByRole('switch', { name: 'Exa' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Filesystem' })).not.toBeChecked()
    // The connector is the only switch there is — its tools are counted, not
    // listed, and none of them can be toggled on its own.
    expect(screen.getAllByRole('switch')).toHaveLength(2)
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.queryByText('web_search_exa')).toBeNull()
    // One connector connected out of two.
    expect(screen.getByText('connectors:1')).toBeInTheDocument()
  })

  it('hides the browser server the Browse button owns', () => {
    useMCPServers.setState({
      mcpServers: {
        'Jan Browser MCP': { command: '', args: [], env: {}, active: true },
      },
    })
    useAppState.setState({ tools: [tool('Jan Browser MCP', 'browser_click')] })

    renderDropdown()

    expect(screen.queryByRole('switch', { name: 'Jan Browser MCP' })).toBeNull()
    expect(screen.getByText('common:connectorsMenu.empty')).toBeInTheDocument()
  })

  it('connects a server and unmutes its tools when switched on', async () => {
    const config = { command: 'npx', args: ['x'], env: {}, active: false }
    useMCPServers.setState({ mcpServers: { filesystem: config } })
    useToolAvailable.setState({
      disabledTools: { 'thread-1': ['filesystem::read_file', 'exa::search'] },
    })

    renderDropdown()
    await userEvent.click(screen.getByRole('switch', { name: 'Filesystem' }))

    await waitFor(() =>
      expect(activateMCPServer).toHaveBeenCalledWith('filesystem', {
        ...config,
        active: true,
      })
    )
    expect(useMCPServers.getState().mcpServers.filesystem.active).toBe(true)
    // Only this server's tools are unmuted; the others stay as they were.
    expect(useToolAvailable.getState().disabledTools['thread-1']).toEqual([
      'exa::search',
    ])
  })

  it('disconnects a server when switched off', async () => {
    useMCPServers.setState({
      mcpServers: { exa: { command: '', args: [], env: {}, active: true } },
    })
    useAppState.setState({ tools: [tool('exa', 'web_search_exa')] })

    renderDropdown()
    await userEvent.click(screen.getByRole('switch', { name: 'Exa' }))

    await waitFor(() =>
      expect(deactivateMCPServer).toHaveBeenCalledWith('exa')
    )
    expect(useMCPServers.getState().mcpServers.exa.active).toBe(false)
  })

  it('leaves the stored config off when the server fails to start', async () => {
    activateMCPServer.mockRejectedValueOnce(new Error('spawn failed') as never)
    useMCPServers.setState({
      mcpServers: { filesystem: { command: 'npx', args: [], env: {}, active: false } },
    })

    renderDropdown()
    await userEvent.click(screen.getByRole('switch', { name: 'Filesystem' }))

    await waitFor(() =>
      expect(useMCPServers.getState().mcpServers.filesystem.active).toBe(false)
    )
  })

  it('clears tools an older build muted on a connected server', () => {
    // Nothing can unmute a single tool any more, so a leftover would sit in
    // storage muting it forever.
    useMCPServers.setState({
      mcpServers: {
        exa: { command: '', args: [], env: {}, active: true },
        filesystem: { command: 'npx', args: [], env: {}, active: false },
      },
    })
    useAppState.setState({ tools: [tool('exa', 'web_search_exa')] })
    useToolAvailable.setState({
      disabledTools: {
        'thread-1': ['exa::web_search_exa', 'filesystem::read_file'],
      },
    })

    renderDropdown()

    // The disconnected server keeps its entry — it is switched off as a whole.
    expect(useToolAvailable.getState().disabledTools['thread-1']).toEqual([
      'filesystem::read_file',
    ])
  })

  it('opens the connectors page from the menu footer', async () => {
    renderDropdown()

    await userEvent.click(screen.getByText('common:connectorsMenu.manage'))

    expect(navigate).toHaveBeenCalledWith({ to: '/connectors/' })
  })
})
