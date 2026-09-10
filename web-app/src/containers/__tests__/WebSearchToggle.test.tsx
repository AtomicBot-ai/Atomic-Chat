import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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

const currentThreadId = vi.hoisted(() => ({ current: 'thread-1' as string | undefined }))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: () => ({
    getCurrentThread: () =>
      currentThreadId.current ? { id: currentThreadId.current } : undefined,
  }),
}))

import WebSearchToggle from '../WebSearchToggle'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useToolAvailable } from '@/hooks/useToolAvailable'

const EXA = {
  command: '',
  args: [],
  env: {},
  type: 'http' as const,
  url: 'https://mcp.exa.ai/mcp',
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
    vi.clearAllMocks()
    currentThreadId.current = 'thread-1'
    useMCPServers.setState({ mcpServers: {} })
    useToolAvailable.setState({ disabledTools: {}, defaultDisabledTools: [] })
  })

  it('stays hidden when no web search server is configured', () => {
    useMCPServers.setState({
      mcpServers: { filesystem: { command: 'npx', args: [], env: {} } },
    })

    const { container } = render(<WebSearchToggle />)

    expect(container).toBeEmptyDOMElement()
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
