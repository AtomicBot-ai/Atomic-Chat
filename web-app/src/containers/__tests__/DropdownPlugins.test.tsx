import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

// `mcp-connectors:` keys resolve to the English strings so a row's tagline is
// asserted as the words the user reads; every other key stays a key.
vi.mock('@/i18n/react-i18next-compat', async () => {
  const en = (await import('@/locales/en/mcp-connectors.json')).default
  const t = (key: string) => {
    const [ns, path] = key.split(':')
    if (ns !== 'mcp-connectors' || !path) return key
    const hit = path
      .split('.')
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        en
      )
    return typeof hit === 'string' ? hit : key
  }
  return { useTranslation: () => ({ t }) }
})

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
    DropDrawerItem: ({
      children,
      icon,
      onSelect,
      onClick,
      disabled,
    }: Props) => (
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
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
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

const skill = (
  name: string,
  overrides: Partial<AgentSkill> = {}
): AgentSkill => ({
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
    useGeneralSetting.setState({ agentModeEnabled: false })
    useToolAvailable.setState({ disabledTools: {}, defaultDisabledTools: [] })
  })

  it('gives every configured server one switch, connected or not', () => {
    useMCPServers.setState({
      mcpServers: {
        exa: { command: '', args: [], env: {}, active: true },
        resend: { command: 'npx', args: [], env: {}, active: false },
      },
    })
    useAppState.setState({
      tools: [tool('exa', 'web_search_exa'), tool('exa', 'crawling_exa')],
    })

    renderDropdown()

    expect(screen.getByRole('switch', { name: 'Exa' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Resend' })).not.toBeChecked()
    // The connector is the only switch there is — its tools are counted, not
    // listed, and none of them can be toggled on its own.
    expect(screen.getAllByRole('switch')).toHaveLength(2)
    // The row says what the connector does; the tool count (the cost label
    // falls back to it until the transport has measured the tool block) is
    // in its tooltip.
    expect(screen.getByTestId('connector-cost-exa')).toHaveTextContent(
      'Web search'
    )
    expect(
      screen.getByTestId('connector-cost-exa').getAttribute('title')
    ).toContain('common:connectorsMenu.toolCount')
    expect(screen.queryByText('web_search_exa')).toBeNull()
    // One connector connected out of two.
    expect(screen.getByText('connectors:1')).toBeInTheDocument()
  })

  it('names a catalog connector by what it does instead of counting its tools', () => {
    useMCPServers.setState({
      mcpServers: {
        exa: { command: '', args: [], env: {}, active: true },
        resend: { command: 'npx', args: [], env: {}, active: false },
      },
    })
    useAppState.setState({
      tools: [tool('exa', 'web_search_exa'), tool('exa', 'crawling_exa')],
    })

    renderDropdown()

    const exa = screen.getByTestId('connector-cost-exa')
    expect(exa).toHaveTextContent('Web search')
    expect(exa).not.toHaveTextContent('common:connectorsMenu.toolCount')
    // The count is still one hover away.
    expect(exa.getAttribute('title')).toContain(
      'common:connectorsMenu.toolCount'
    )
    // A connector that is off has no tools to count, but still says what it is for.
    expect(screen.getByTestId('connector-cost-resend')).toHaveTextContent(
      'Transactional email'
    )
  })

  it('keeps the tool count for a server the catalog does not know', () => {
    useMCPServers.setState({
      mcpServers: {
        'my-tools': { command: 'npx', args: [], env: {}, active: true },
      },
    })
    useAppState.setState({
      tools: [tool('my-tools', 'do_a'), tool('my-tools', 'do_b')],
    })

    renderDropdown()

    const row = screen.getByTestId('connector-cost-my-tools')
    expect(row).toHaveTextContent(/^common:connectorsMenu\.toolCount$/)
    expect(row).not.toHaveAttribute('title')
  })

  it('keeps the tagline when single tools are off and moves "k of N" to the tooltip', () => {
    useMCPServers.setState({
      mcpServers: { exa: { command: '', args: [], env: {}, active: true } },
    })
    useAppState.setState({
      tools: [tool('exa', 'web_search_exa'), tool('exa', 'crawling_exa')],
    })
    useToolAvailable.setState({
      disabledTools: { 'thread-1': ['exa::web_search_exa'] },
    })

    renderDropdown()

    const exa = screen.getByTestId('connector-cost-exa')
    expect(exa).toHaveTextContent('Web search')
    expect(exa).not.toHaveTextContent('common:connectorsMenu.toolCountPartial')
    expect(exa.getAttribute('title')).toContain(
      'common:connectorsMenu.toolCountPartial'
    )
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

  // The system servers never ride a chat request and are filtered out of this
  // menu, so a user who switched the filesystem server on saw nothing at all
  // and concluded it had stopped working. Say why, and only while it is true.
  it('explains that an active system server is agent-mode only', () => {
    useGeneralSetting.setState({ agentModeEnabled: false })
    useMCPServers.setState({
      mcpServers: {
        filesystem: { command: 'npx', args: [], env: {}, active: true },
      },
    })

    renderDropdown()

    expect(
      screen.getByText('common:connectorsMenu.systemServersAgentOnly')
    ).toBeInTheDocument()
  })

  it('drops the note once Agent mode is on, or when no system server is', () => {
    useGeneralSetting.setState({ agentModeEnabled: true })
    useMCPServers.setState({
      mcpServers: {
        filesystem: { command: 'npx', args: [], env: {}, active: true },
      },
    })
    const { unmount } = renderDropdown()
    expect(
      screen.queryByText('common:connectorsMenu.systemServersAgentOnly')
    ).toBeNull()
    unmount()

    useGeneralSetting.setState({ agentModeEnabled: false })
    useMCPServers.setState({
      mcpServers: {
        filesystem: { command: 'npx', args: [], env: {}, active: false },
      },
    })
    renderDropdown()
    expect(
      screen.queryByText('common:connectorsMenu.systemServersAgentOnly')
    ).toBeNull()
  })

  it('connects a server and keeps its per-tool switches', async () => {
    const config = { command: 'npx', args: ['x'], env: {}, active: false }
    useMCPServers.setState({ mcpServers: { resend: config } })
    useToolAvailable.setState({
      disabledTools: { 'thread-1': ['resend::send_email', 'exa::search'] },
    })

    renderDropdown()
    await userEvent.click(screen.getByRole('switch', { name: 'Resend' }))

    await waitFor(() =>
      expect(activateMCPServer).toHaveBeenCalledWith('resend', {
        ...config,
        active: true,
      })
    )
    expect(useMCPServers.getState().mcpServers.resend.active).toBe(true)
    // A tool the user switched off stays off across a restart; the tools
    // dialog is where that shows and where it is undone.
    expect(useToolAvailable.getState().disabledTools['thread-1']).toEqual([
      'resend::send_email',
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

    await waitFor(() => expect(deactivateMCPServer).toHaveBeenCalledWith('exa'))
    expect(useMCPServers.getState().mcpServers.exa.active).toBe(false)
  })

  it('leaves the stored config off when the server fails to start', async () => {
    activateMCPServer.mockRejectedValueOnce(new Error('spawn failed') as never)
    useMCPServers.setState({
      mcpServers: {
        resend: { command: 'npx', args: [], env: {}, active: false },
      },
    })

    renderDropdown()
    await userEvent.click(screen.getByRole('switch', { name: 'Resend' }))

    await waitFor(() =>
      expect(useMCPServers.getState().mcpServers.resend.active).toBe(false)
    )
  })

  it('reports a connector with single tools off as "k of N"', () => {
    useMCPServers.setState({
      mcpServers: {
        exa: { command: '', args: [], env: {}, active: true },
        resend: { command: 'npx', args: [], env: {}, active: false },
      },
    })
    useAppState.setState({
      tools: [tool('exa', 'web_search_exa'), tool('exa', 'crawling_exa')],
    })
    useToolAvailable.setState({
      disabledTools: {
        'thread-1': ['exa::web_search_exa', 'resend::send_email'],
      },
    })

    renderDropdown()

    // Nothing sweeps the keys: they are the user's switches now.
    expect(useToolAvailable.getState().disabledTools['thread-1']).toEqual([
      'exa::web_search_exa',
      'resend::send_email',
    ])
    expect(
      screen.getByTestId('connector-cost-exa').getAttribute('title')
    ).toContain('common:connectorsMenu.toolCountPartial')
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
    useMCPServers.setState({
      mcpServers: { exa: exaConfig, linear: linearConfig },
    })
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
            {
              server: 'linear',
              toolCount: 70,
              tokens: 18_000,
              ctxShare: 1.1,
              heavy: true,
            },
            {
              server: 'exa',
              toolCount: 1,
              tokens: 200,
              ctxShare: 0.01,
              heavy: false,
            },
          ],
          heavyServers: ['linear'],
          tooHeavy: true,
        },
      },
    })

    renderDropdown()

    const linear = screen.getByTestId('connector-cost-linear')
    expect(linear).toHaveTextContent('Issues & projects')
    // The measured cost and the heavy warning share the tooltip.
    expect(linear.getAttribute('title')).toContain(
      'common:connectorsMenu.costShare'
    )
    expect(linear.getAttribute('title')).toContain(
      'common:connectorsMenu.heavy'
    )
    expect(linear).toHaveAttribute('data-heavy', 'true')
    expect(screen.getByTestId('connector-cost-exa')).not.toHaveAttribute(
      'data-heavy'
    )
  })

  it('mutes a connector for this chat from its tools dialog, not the global switch', async () => {
    const user = userEvent.setup()
    renderDropdown()

    await user.click(screen.getByTestId('connector-tools-linear'))
    const dialog = await screen.findByTestId('connector-tools-dialog')
    expect(dialog).toHaveTextContent('common:connectorTools.scopeChat')

    await user.click(screen.getByTestId('connector-tools-master'))

    expect(
      useToolAvailable.getState().getMutedServersForThread('thread-1')
    ).toEqual(['linear'])
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
    expect(
      useToolAvailable.getState().getMutedServersForThread('thread-1')
    ).toEqual([])
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
    expect(
      screen.getByTestId('connector-cost-linear').getAttribute('title')
    ).toContain('common:connectorsMenu.toolCountPartial')
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
    expect(useToolAvailable.getState().mutedServers['thread-1']).toEqual([
      'linear',
    ])
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
        'filesystem': { command: 'npx', args: [], env: {}, active: true },
        'fetch': { command: 'uvx', args: [], env: {}, active: false },
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

describe('DropdownPlugins connector row anatomy', () => {
  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver as never
  })

  beforeEach(() => {
    vi.clearAllMocks()
    useAppState.setState({ tools: [], toolCostReports: {} })
    useGeneralSetting.setState({ agentModeEnabled: false })
    useToolAvailable.setState({
      disabledTools: {},
      defaultDisabledTools: [],
      mutedServers: {},
      defaultMutedServers: [],
    })
  })

  // The fresh-install menu showed a 20 px icon, an 11 px tagline and nothing
  // level with anything. The row follows the model rows' anatomy instead: a
  // 32 px round mark, a title line, a tagline line, one fixed action slot.
  it('lays a connector out as a 32 px mark, a title, a tagline and one action slot', () => {
    useMCPServers.setState({
      mcpServers: {
        'exa': { command: '', args: [], env: {}, active: true },
        'my-tools': { command: 'npx', args: [], env: {}, active: false },
      },
    })
    useAppState.setState({ tools: [tool('exa', 'web_search_exa')] })

    renderDropdown()

    // The mark is the model rows' 32 px round slot: a catalog connector's
    // brand tile fills it, a hand-added server gets its initial in it.
    const mark = screen.getByTestId('connector-mark-exa')
    expect(mark).toHaveClass('size-8', 'rounded-full', 'bg-secondary')
    expect(mark).toHaveAttribute('aria-hidden', 'true')
    expect(mark.firstElementChild).toHaveClass('size-full', 'rounded-full')
    expect(mark.querySelector('img')).toHaveAttribute(
      'src',
      '/images/connectors/exa.svg'
    )
    expect(screen.getByTestId('connector-mark-my-tools')).toHaveTextContent(
      /^m$/
    )

    // Title and tagline: one line each, cut with an ellipsis, the pair
    // centred against the mark at a height every row shares.
    const title = screen.getByTestId('connector-name-exa')
    expect(title).toHaveTextContent('Exa')
    expect(title).toHaveClass('truncate', 'text-sm', 'font-medium')
    const tagline = screen.getByTestId('connector-cost-exa')
    expect(tagline).toHaveTextContent('Web search')
    expect(tagline).toHaveClass('truncate', 'text-xs', 'text-muted-foreground')
    expect(tagline).not.toHaveClass('text-[11px]')
    expect(mark.parentElement).toHaveClass('items-center', 'min-h-9')
    expect(
      screen.getByTestId('connector-mark-my-tools').parentElement
    ).toHaveClass('items-center', 'min-h-9')

    // The switch — and the tools button once the connector is on — sit in
    // one fixed-width slot, so the switches of every row line up.
    const exaActions = screen.getByTestId('connector-actions-exa')
    expect(exaActions).toHaveClass('w-16', 'justify-end')
    expect(
      within(exaActions).getByRole('switch', { name: 'Exa' })
    ).toBeChecked()
    expect(
      within(exaActions).getByTestId('connector-tools-exa')
    ).toBeInTheDocument()
    const otherActions = screen.getByTestId('connector-actions-my-tools')
    expect(otherActions).toHaveClass('w-16', 'justify-end')
    expect(
      within(otherActions).getByRole('switch', { name: 'my-tools' })
    ).not.toBeChecked()
    expect(
      within(otherActions).queryByTestId('connector-tools-my-tools')
    ).toBeNull()
  })

  it('greys the title of a connector muted for this chat, on the same row shape', () => {
    useMCPServers.setState({
      mcpServers: { exa: { command: '', args: [], env: {}, active: true } },
    })
    useAppState.setState({ tools: [tool('exa', 'web_search_exa')] })
    useToolAvailable.setState({ mutedServers: { 'thread-1': ['exa'] } })

    renderDropdown()

    expect(screen.getByTestId('connector-name-exa')).toHaveClass(
      'text-muted-foreground'
    )
    expect(screen.getByTestId('connector-cost-exa')).toHaveTextContent(
      'common:connectorsMenu.mutedForChat'
    )
    expect(screen.getByTestId('connector-mark-exa')).toHaveClass('size-8')
  })
})
