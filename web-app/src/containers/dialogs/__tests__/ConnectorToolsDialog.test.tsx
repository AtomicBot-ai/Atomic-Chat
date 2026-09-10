import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

import ConnectorToolsDialog from '../ConnectorToolsDialog'
import { useAppState } from '@/hooks/useAppState'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import type { MCPTool } from '@/types/completion'

const tool = (server: string, name: string, description = ''): MCPTool => ({
  server,
  name,
  description,
  inputSchema: {},
})

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const renderDialog = (
  scope: React.ComponentProps<typeof ConnectorToolsDialog>['scope'] = {
    kind: 'default',
  }
) =>
  render(
    <ConnectorToolsDialog
      open
      onOpenChange={() => {}}
      serverKey="linear"
      scope={scope}
    />
  )

describe('ConnectorToolsDialog', () => {
  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver as never
  })

  beforeEach(() => {
    useAppState.setState({
      tools: [
        tool('linear', 'list_issues', 'List issues in a team'),
        tool('linear', 'create_issue', 'Create an issue'),
        tool('linear', 'add_comment', 'Comment on an issue'),
        tool('exa', 'web_search_exa'),
      ],
    })
    useToolAvailable.setState({
      disabledTools: {},
      defaultDisabledTools: [],
      mutedServers: {},
      defaultMutedServers: [],
    })
  })

  it('lists only this server tools, sorted, with the defaults scope note', () => {
    renderDialog()

    const switches = screen
      .getAllByRole('switch')
      .map((el) => el.getAttribute('aria-label'))
    // First switch is the connector's own; the rest are its tools by name.
    expect(switches.slice(1)).toEqual([
      'add_comment',
      'create_issue',
      'list_issues',
    ])
    expect(screen.queryByText('web_search_exa')).toBeNull()
    expect(screen.getByTestId('connector-tools-dialog')).toHaveTextContent(
      'common:connectorTools.scopeDefault'
    )
    expect(screen.getByTestId('connector-tools-dialog')).toHaveTextContent(
      'common:connectorTools.summary:{"enabled":3,"count":3}'
    )
  })

  it('edits the defaults when opened from the connectors page', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole('switch', { name: 'create_issue' }))

    expect(useToolAvailable.getState().defaultDisabledTools).toEqual([
      'linear::create_issue',
    ])
    expect(useToolAvailable.getState().disabledTools).toEqual({})
    expect(
      screen.getByRole('switch', { name: 'create_issue' })
    ).not.toBeChecked()
  })

  it('edits one chat when opened from the composer', async () => {
    const user = userEvent.setup()
    useToolAvailable.setState({ defaultDisabledTools: ['linear::add_comment'] })
    renderDialog({ kind: 'thread', threadId: 'thread-1' })

    // The default-off tool shows off here too, since the chat inherits it.
    expect(
      screen.getByRole('switch', { name: 'add_comment' })
    ).not.toBeChecked()

    await user.click(screen.getByRole('switch', { name: 'create_issue' }))

    expect(useToolAvailable.getState().disabledTools['thread-1']).toEqual([
      'linear::add_comment',
      'linear::create_issue',
    ])
    expect(useToolAvailable.getState().defaultDisabledTools).toEqual([
      'linear::add_comment',
    ])
  })

  it('turns every tool off and on in bulk', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByText('common:connectorTools.disableAll'))
    expect(useToolAvailable.getState().defaultDisabledTools).toEqual([
      'linear::add_comment',
      'linear::create_issue',
      'linear::list_issues',
    ])

    await user.click(screen.getByText('common:connectorTools.enableAll'))
    expect(useToolAvailable.getState().defaultDisabledTools).toEqual([])
  })

  it('parks the tool switches while the connector is off, and brings all tools back with it', async () => {
    const user = userEvent.setup()
    useToolAvailable.setState({
      defaultDisabledTools: [
        'linear::add_comment',
        'linear::create_issue',
        'linear::list_issues',
      ],
    })
    renderDialog()

    await user.click(screen.getByTestId('connector-tools-master'))
    expect(useToolAvailable.getState().defaultMutedServers).toEqual(['linear'])
    expect(screen.getByRole('switch', { name: 'list_issues' })).toBeDisabled()
    expect(
      screen.getByText('common:connectorTools.mutedHint')
    ).toBeInTheDocument()

    // Back on with every tool off would change nothing visible.
    await user.click(screen.getByTestId('connector-tools-master'))
    expect(useToolAvailable.getState().defaultMutedServers).toEqual([])
    expect(useToolAvailable.getState().defaultDisabledTools).toEqual([])
  })

  it('filters the list by name or description', async () => {
    const user = userEvent.setup()
    renderDialog()

    const search = () =>
      screen.getByRole('textbox', { name: 'common:connectorTools.search' })
    await user.type(search(), 'comment')

    expect(
      screen.getByRole('switch', { name: 'add_comment' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'list_issues' })).toBeNull()

    await user.clear(search())
    await user.type(search(), 'zzz')
    expect(
      screen.getByText('common:connectorTools.noMatches')
    ).toBeInTheDocument()
  })

  it('says so when the server has no tools loaded', () => {
    useAppState.setState({ tools: [] })
    renderDialog()

    expect(
      screen.getByText('common:connectorTools.noTools')
    ).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
