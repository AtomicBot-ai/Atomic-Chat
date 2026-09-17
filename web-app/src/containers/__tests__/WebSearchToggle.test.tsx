import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const activateMCPServer = vi.hoisted(() => vi.fn(async () => {}))
const deactivateMCPServer = vi.hoisted(() => vi.fn(async () => {}))
const getToolsWithStatus = vi.hoisted(() => vi.fn())
const updateMCPConfig = vi.hoisted(() => vi.fn(async () => {}))

const mcp = () => ({
  activateMCPServer,
  deactivateMCPServer,
  updateMCPConfig,
  getToolsWithStatus,
})

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ mcp }),
  getServiceHub: () => ({
    mcp,
    rag: () => ({ getToolNames: async () => [] }),
    events: () => ({ listen: async () => () => {} }),
  }),
}))

const currentThreadId = vi.hoisted(() => ({
  current: 'thread-1' as string | undefined,
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: () => ({
    getCurrentThread: () =>
      currentThreadId.current ? { id: currentThreadId.current } : undefined,
  }),
}))

import { useTools } from '@/hooks/useTools'
import WebSearchToggle from '../WebSearchToggle'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useAppState } from '@/hooks/useAppState'
import { useToolAvailable } from '@/hooks/useToolAvailable'

const EXA = {
  command: '',
  args: [],
  env: {},
  type: 'http' as const,
  url: 'https://mcp.exa.ai/mcp',
}

const SEARCH_TOOL = {
  name: 'web_search_exa',
  server: 'exa',
  description: 'Search the web',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
}

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('WebSearchToggle', () => {
  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver
  })

  beforeEach(() => {
    useAppState.setState({ tools: [SEARCH_TOOL] })
    activateMCPServer.mockImplementation(async () => {
      useAppState.getState().updateTools([SEARCH_TOOL])
    })
    vi.clearAllMocks()
    getToolsWithStatus.mockImplementation(async () => ({
      tools: useAppState.getState().tools,
      servers: [],
    }))
    currentThreadId.current = 'thread-1'
    useMCPServers.setState({ mcpServers: {} })
    useToolAvailable.setState({
      disabledTools: {},
      defaultDisabledTools: [],
      mutedServers: {},
      defaultMutedServers: [],
    })
  })

  it('stays hidden when no web search server is configured', () => {
    useMCPServers.setState({
      mcpServers: { filesystem: { command: 'npx', args: [], env: {} } },
    })

    const { container } = render(<WebSearchToggle />)

    expect(container).toBeEmptyDOMElement()
  })

  it('does not promise search after startup fails with persisted active=true', () => {
    useMCPServers.setState({ mcpServers: { exa: { ...EXA, active: true } } })
    // get_tools returns no tools when the Exa handshake returns HTTP 403.
    useAppState.setState({ tools: [] })
    render(<WebSearchToggle />)
    expect(
      screen.getByRole('button', { name: 'common:webSearchToggleUnavailable' })
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('reflects the actual discovery response after an HTTP 403 startup failure', async () => {
    useMCPServers.setState({ mcpServers: { exa: { ...EXA, active: true } } })
    getToolsWithStatus.mockResolvedValueOnce({
      tools: [],
      servers: [{ name: 'exa', status: 'error', error: 'HTTP 403 Forbidden' }],
    })
    function StartupComposer() {
      useTools()
      return <WebSearchToggle />
    }
    render(<StartupComposer />)
    expect(
      await screen.findByRole('button', {
        name: 'common:webSearchToggleUnavailable',
      })
    ).toHaveAttribute('aria-pressed', 'false')
    expect(useAppState.getState().tools).toEqual([])
  })

  it('retries a failed startup and shows enabled only after tools are discovered', async () => {
    useMCPServers.setState({ mcpServers: { exa: { ...EXA, active: true } } })
    useAppState.setState({ tools: [] })
    render(<WebSearchToggle />)
    await userEvent.click(
      screen.getByRole('button', { name: 'common:webSearchToggleUnavailable' })
    )
    expect(
      await screen.findByRole('button', {
        name: 'common:webSearchToggleEnabled',
      })
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps explaining unavailability when the retry also fails', async () => {
    useMCPServers.setState({ mcpServers: { exa: { ...EXA, active: true } } })
    useAppState.setState({ tools: [] })
    activateMCPServer.mockRejectedValueOnce(new Error('HTTP 403 Forbidden'))
    render(<WebSearchToggle />)
    await userEvent.click(
      screen.getByRole('button', { name: 'common:webSearchToggleUnavailable' })
    )
    expect(
      await screen.findByRole('button', {
        name: 'common:webSearchToggleUnavailable',
      })
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps search unavailable when activation succeeds but exposes no tools', async () => {
    useMCPServers.setState({ mcpServers: { exa: { ...EXA, active: false } } })
    useAppState.setState({ tools: [] })
    activateMCPServer.mockResolvedValueOnce(undefined)
    render(<WebSearchToggle />)
    await userEvent.click(
      screen.getByRole('button', { name: 'common:webSearchToggleDisabled' })
    )
    expect(
      await screen.findByRole('button', {
        name: 'common:webSearchToggleUnavailable',
      })
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('does not report enabled when only a fetch tool was discovered', () => {
    useMCPServers.setState({ mcpServers: { exa: { ...EXA, active: true } } })
    useAppState.setState({ tools: [{ ...SEARCH_TOOL, name: 'web_fetch_exa' }] })
    render(<WebSearchToggle />)
    expect(
      screen.getByRole('button', { name: 'common:webSearchToggleUnavailable' })
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('unmutes a connected server for this chat when the globe is switched on', async () => {
    useMCPServers.setState({ mcpServers: { exa: { ...EXA, active: true } } })
    useToolAvailable.setState({ mutedServers: { 'thread-1': ['exa'] } })
    render(<WebSearchToggle />)
    await userEvent.click(
      screen.getByRole('button', { name: 'common:webSearchToggleDisabled' })
    )
    expect(
      await screen.findByRole('button', {
        name: 'common:webSearchToggleEnabled',
      })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      useToolAvailable.getState().getMutedServersForThread('thread-1')
    ).toEqual([])
  })

  it('activates the server and unmutes its tools when switched on', async () => {
    useMCPServers.setState({ mcpServers: { exa: { ...EXA, active: false } } })
    useToolAvailable.setState({
      disabledTools: { 'thread-1': ['exa::web_search_exa', 'fetch::fetch'] },
    })

    render(<WebSearchToggle />)
    await userEvent.click(
      screen.getByRole('button', { name: 'common:webSearchToggleDisabled' })
    )

    await waitFor(() =>
      expect(activateMCPServer).toHaveBeenCalledWith('exa', {
        ...EXA,
        active: true,
      })
    )
    expect(useMCPServers.getState().mcpServers.exa?.active).toBe(true)
    // Only this server's tools get unmuted; the rest keep their switches.
    expect(useToolAvailable.getState().disabledTools['thread-1']).toEqual([
      'fetch::fetch',
    ])
    await screen.findByRole('button', {
      name: 'common:webSearchToggleEnabled',
    })
  })

  it('deactivates the server when switched off', async () => {
    useMCPServers.setState({ mcpServers: { exa: { ...EXA, active: true } } })

    render(<WebSearchToggle />)
    await userEvent.click(
      screen.getByRole('button', { name: 'common:webSearchToggleEnabled' })
    )

    await waitFor(() => expect(deactivateMCPServer).toHaveBeenCalledWith('exa'))
    expect(activateMCPServer).not.toHaveBeenCalled()
    expect(useMCPServers.getState().mcpServers.exa?.active).toBe(false)
  })

  it('keeps the server off when activation fails', async () => {
    useMCPServers.setState({ mcpServers: { exa: { ...EXA, active: false } } })
    activateMCPServer.mockRejectedValueOnce(new Error('boom'))

    render(<WebSearchToggle />)
    await act(async () => {
      await userEvent.click(
        screen.getByRole('button', { name: 'common:webSearchToggleDisabled' })
      )
    })

    await waitFor(() =>
      expect(useMCPServers.getState().mcpServers.exa?.active).toBe(false)
    )
  })

  it('edits the defaults instead of a thread on the index page', async () => {
    useMCPServers.setState({ mcpServers: { exa: { ...EXA, active: false } } })
    useToolAvailable.setState({
      defaultDisabledTools: ['exa::web_search_exa', 'fetch::fetch'],
    })

    render(<WebSearchToggle initialMessage />)
    await userEvent.click(
      screen.getByRole('button', { name: 'common:webSearchToggleDisabled' })
    )

    await waitFor(() =>
      expect(useToolAvailable.getState().defaultDisabledTools).toEqual([
        'fetch::fetch',
      ])
    )
    expect(useToolAvailable.getState().disabledTools).toEqual({})
  })
})
