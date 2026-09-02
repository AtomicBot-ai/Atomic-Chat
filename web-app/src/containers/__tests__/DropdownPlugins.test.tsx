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
    disabled?: boolean
    onSelect?: (event: { preventDefault: () => void }) => void
    onClick?: (event: React.MouseEvent) => void
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
    DropDrawerItem: ({ children, icon, onSelect, onClick, disabled }: Props) => (
      <div>
        <button
          disabled={disabled}
          onClick={(event) => {
            onClick?.(event)
            // A menu item runs its select through the same click and skips it
            // when the handler prevented the default — same as radix.
            if (!event.defaultPrevented) onSelect?.(event)
          }}
        >
          {children}
        </button>
        {icon}
      </div>
    ),
  }
})

import DropdownPlugins from '../DropdownPlugins'
import { useAppState } from '@/hooks/useAppState'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import type { AgentSkill } from '@/services/agent/skills'
import type { MCPTool } from '@/types/completion'

type DropdownPluginsProps = React.ComponentProps<typeof DropdownPlugins>

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

const skill = (name: string, overrides: Partial<AgentSkill> = {}): AgentSkill => ({
  name,
  description: `${name} description`,
  version: '1.0.0',
  requiresTools: [],
  requiresScripts: [],
  dangerous: false,
  platforms: null,
  enabled: true,
  compatible: true,
  reserved: false,
  unavailableReasons: [],
  error: null,
  ...overrides,
})

const renderDropdown = (props: Partial<DropdownPluginsProps> = {}) =>
  render(
    <DropdownPlugins {...props}>
      {(_isOpen, active) => <button>connectors:{active}</button>}
    </DropdownPlugins>
  )

describe('DropdownPlugins', () => {
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
        serper: { command: 'npx', args: [], env: {}, active: false },
      },
    })
    useAppState.setState({
      tools: [tool('exa', 'web_search_exa'), tool('exa', 'crawling_exa')],
    })

    renderDropdown()

    expect(screen.getByRole('switch', { name: 'Exa' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Serper' })).not.toBeChecked()
    // The connector is the only switch there is — its tools are counted, not
    // listed, and none of them can be toggled on its own.
    expect(screen.getAllByRole('switch')).toHaveLength(2)
    // The row carries the tool count (the cost label falls back to it until
    // the transport has measured the tool block).
    expect(screen.getByTestId('connector-cost-exa')).toHaveTextContent(
      'common:connectorsMenu.toolCount'
    )
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

  it('connects a server and keeps its per-tool switches', async () => {
    const config = { command: 'npx', args: ['x'], env: {}, active: false }
    useMCPServers.setState({ mcpServers: { serper: config } })
    useToolAvailable.setState({
      disabledTools: { 'thread-1': ['serper::google_search', 'exa::search'] },
    })

    renderDropdown()
    await userEvent.click(screen.getByRole('switch', { name: 'Serper' }))

    await waitFor(() =>
      expect(activateMCPServer).toHaveBeenCalledWith('serper', {
        ...config,
        active: true,
      })
    )
    expect(useMCPServers.getState().mcpServers.serper.active).toBe(true)
    // A tool the user switched off stays off across a restart; the tools
    // dialog is where that shows and where it is undone.
    expect(useToolAvailable.getState().disabledTools['thread-1']).toEqual([
      'serper::google_search',
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
      mcpServers: { serper: { command: 'npx', args: [], env: {}, active: false } },
    })

    renderDropdown()
    await userEvent.click(screen.getByRole('switch', { name: 'Serper' }))

    await waitFor(() =>
      expect(useMCPServers.getState().mcpServers.serper.active).toBe(false)
    )
  })

  it('reports a connector with single tools off as "k of N"', () => {
    useMCPServers.setState({
      mcpServers: {
        exa: { command: '', args: [], env: {}, active: true },
        serper: { command: 'npx', args: [], env: {}, active: false },
      },
    })
    useAppState.setState({
      tools: [tool('exa', 'web_search_exa'), tool('exa', 'crawling_exa')],
    })
    useToolAvailable.setState({
      disabledTools: {
        'thread-1': ['exa::web_search_exa', 'serper::google_search'],
      },
    })

    renderDropdown()

    // Nothing sweeps the keys: they are the user's switches now.
    expect(useToolAvailable.getState().disabledTools['thread-1']).toEqual([
      'exa::web_search_exa',
      'serper::google_search',
    ])
    expect(screen.getByTestId('connector-cost-exa')).toHaveTextContent(
      'common:connectorsMenu.toolCountPartial'
    )
  })

  it('opens the connectors page from the section footer', async () => {
    renderDropdown()

    await userEvent.click(screen.getByText('common:connectorsMenu.manage'))

    expect(navigate).toHaveBeenCalledWith({ to: '/connectors/' })
  })

  it('leaves out the skills section where skills do not exist', () => {
    renderDropdown()

    expect(screen.queryByText('common:skills')).toBeNull()
  })

  it('switches a skill with the same flag the skills page flips', async () => {
    const onToggleSkill = vi.fn()
    renderDropdown({
      skills: [skill('pdf'), skill('xlsx', { enabled: false })],
      onToggleSkill,
    })

    // Collapsed by default, so the rows only exist once the section opens.
    expect(screen.queryByRole('switch', { name: 'pdf' })).toBeNull()
    await userEvent.click(screen.getByText('common:skills'))

    expect(screen.getByRole('switch', { name: 'pdf' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'xlsx' })).not.toBeChecked()

    await userEvent.click(screen.getByRole('switch', { name: 'pdf' }))
    expect(onToggleSkill).toHaveBeenCalledWith('pdf', false)
  })

  it('keeps a broken skill read-only', async () => {
    renderDropdown({
      skills: [skill('broken', { error: 'bad frontmatter' })],
      onToggleSkill: vi.fn(),
    })
    await userEvent.click(screen.getByText('common:skills'))

    expect(screen.getByRole('switch', { name: 'broken' })).toBeDisabled()
  })

  it('opens the skills page from the section footer', async () => {
    renderDropdown({ skills: [] })
    await userEvent.click(screen.getByText('common:skills'))
    await userEvent.click(screen.getByText('common:pluginsMenu.manageSkills'))

    expect(navigate).toHaveBeenCalledWith({ to: '/skills/' })
  })

  it('collapses the connectors section on demand', async () => {
    useMCPServers.setState({
      mcpServers: { exa: { command: '', args: [], env: {}, active: true } },
    })

    renderDropdown()
    expect(screen.getByRole('switch', { name: 'Exa' })).toBeInTheDocument()

    await userEvent.click(screen.getByText('common:connectors'))

    expect(screen.queryByRole('switch', { name: 'Exa' })).toBeNull()
  })
})

describe('DropdownPlugins tool cost and per-chat mute', () => {
  const exaConfig = { command: '', args: [], env: {}, active: true }
  const linearConfig = { command: '', args: [], env: {}, active: true }

  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver as never
  })

  beforeEach(() => {
    vi.clearAllMocks()
    useMCPServers.setState({ mcpServers: { exa: exaConfig, linear: linearConfig } })
    useAppState.setState({
      tools: [tool('exa', 'web_search_exa'), tool('linear', 'list_issues')],
      toolCostReports: {},
    })
    useToolAvailable.setState({
      disabledTools: {},
      defaultDisabledTools: [],
      mutedServers: {},
      defaultMutedServers: [],
    })
  })

  it('shows the measured cost per connector and flags a heavy one', () => {
    useAppState.setState({
      toolCostReports: {
        'thread-1': {
          totalTokens: 18_200,
          toolCount: 71,
          ctxLen: 16_384,
          ctxShare: 1.1,
          perServer: [
            { server: 'linear', toolCount: 70, tokens: 18_000, ctxShare: 1.1, heavy: true },
            { server: 'exa', toolCount: 1, tokens: 200, ctxShare: 0.01, heavy: false },
          ],
          heavyServers: ['linear'],
          tooHeavy: true,
        },
      },
    })

    renderDropdown()

    const linear = screen.getByTestId('connector-cost-linear')
    expect(linear).toHaveTextContent('common:connectorsMenu.costShare')
    expect(linear).toHaveAttribute('data-heavy', 'true')
    expect(screen.getByTestId('connector-cost-exa')).not.toHaveAttribute('data-heavy')
  })

  it('mutes a connector for this chat from its tools dialog, not the global switch', async () => {
    const user = userEvent.setup()
    renderDropdown()

    await user.click(screen.getByTestId('connector-tools-linear'))
    const dialog = await screen.findByTestId('connector-tools-dialog')
    expect(dialog).toHaveTextContent('common:connectorTools.scopeChat')

    await user.click(screen.getByTestId('connector-tools-master'))

    expect(useToolAvailable.getState().getMutedServersForThread('thread-1')).toEqual([
      'linear',
    ])
    expect(activateMCPServer).not.toHaveBeenCalled()
    expect(deactivateMCPServer).not.toHaveBeenCalled()
    expect(useMCPServers.getState().mcpServers.linear.active).toBe(true)
    expect(screen.getByTestId('connector-cost-linear')).toHaveTextContent(
      'common:connectorsMenu.mutedForChat'
    )
    // Only connectors whose tools ride the chat count in the trigger.
    expect(screen.getByText('connectors:1')).toBeInTheDocument()
    // A muted connector's tool switches are parked until it is back on.
    expect(screen.getByRole('switch', { name: 'list_issues' })).toBeDisabled()

    await user.click(screen.getByTestId('connector-tools-master'))
    expect(useToolAvailable.getState().getMutedServersForThread('thread-1')).toEqual([])
  })

  it('switches one tool off for this chat from the tools dialog', async () => {
    const user = userEvent.setup()
    useAppState.setState({
      tools: [
        tool('exa', 'web_search_exa'),
        tool('linear', 'list_issues'),
        tool('linear', 'create_issue'),
      ],
    })
    renderDropdown()

    await user.click(screen.getByTestId('connector-tools-linear'))
    await user.click(await screen.findByRole('switch', { name: 'list_issues' }))

    expect(useToolAvailable.getState().disabledTools['thread-1']).toEqual([
      'linear::list_issues',
    ])
    expect(useToolAvailable.getState().defaultDisabledTools).toEqual([])
    expect(screen.getByTestId('connector-cost-linear')).toHaveTextContent(
      'common:connectorsMenu.toolCountPartial'
    )
    // The whole connector still rides the chat, so the trigger count holds.
    expect(screen.getByText('connectors:2')).toBeInTheDocument()

    await user.click(screen.getByRole('switch', { name: 'list_issues' }))
    expect(useToolAvailable.getState().disabledTools['thread-1']).toEqual([])
  })

  it('does not sweep a muted connector as a stale per-tool key', async () => {
    useToolAvailable.setState({ mutedServers: { 'thread-1': ['linear'] } })

    renderDropdown()
    await waitFor(() => {
      expect(screen.getByTestId('connector-cost-linear')).toHaveTextContent(
        'common:connectorsMenu.mutedForChat'
      )
    })
    expect(useToolAvailable.getState().mutedServers['thread-1']).toEqual(['linear'])
  })
})

describe('DropdownPlugins system default servers', () => {
  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver as never
  })

  beforeEach(() => {
    vi.clearAllMocks()
    useAppState.setState({ tools: [], toolCostReports: {} })
    useToolAvailable.setState({
      disabledTools: {},
      defaultDisabledTools: [],
      mutedServers: {},
      defaultMutedServers: [],
    })
  })

  it('never lists a system server, on or off — they are agent-mode tooling', () => {
    useMCPServers.setState({
      mcpServers: {
        filesystem: { command: 'npx', args: [], env: {}, active: true },
        fetch: { command: 'uvx', args: [], env: {}, active: false },
        'Jan Browser MCP': { command: '', args: [], env: {}, active: true },
      },
    })
    useAppState.setState({
      tools: [
        tool('filesystem', 'read_file'),
        tool('filesystem', 'write_file'),
        tool('Jan Browser MCP', 'browser_click'),
      ],
    })

    renderDropdown()

    expect(screen.queryByRole('switch', { name: 'filesystem' })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'fetch' })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Jan Browser MCP' })).toBeNull()
    expect(screen.getByText('common:connectorsMenu.empty')).toBeInTheDocument()
    // Nothing rides the chat, so the trigger counts none.
    expect(screen.getByText('connectors:0')).toBeInTheDocument()
  })
})
