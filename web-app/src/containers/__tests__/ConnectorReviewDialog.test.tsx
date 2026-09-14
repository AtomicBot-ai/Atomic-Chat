import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import {
  ConnectorReviewDialog,
  type ConnectorTool,
} from '../ConnectorReviewDialog'
import type { MCPServerConfig } from '@/hooks/useMCPServers'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

/**
 * Task 28 (decision D36, as amended by the user on 2026-09-14): every MCP
 * connector - built in, from the catalog, added by hand or imported - is
 * reviewed with Allow / Preview / Cancel before Radium connects to it. Preview
 * never lets the AI use anything. For a local program it shows what would run
 * without running it; listing that program's tools is a separate, clearly
 * warned step because it has to start the program.
 */

const localProgram: MCPServerConfig = {
  command: 'npx',
  args: [
    '-y',
    '@modelcontextprotocol/server-filesystem',
    'C:/Users/me/Documents',
  ],
  env: { API_TOKEN: 'secret-value' },
}

const webService: MCPServerConfig = {
  command: '',
  args: [],
  env: {},
  type: 'http',
  url: 'https://mcp.linear.app/mcp',
  headers: { Authorization: 'Bearer abc' },
}

const tools: ConnectorTool[] = [
  { name: 'list_issues', description: 'List issues', readOnly: true },
  { name: 'create_issue', description: 'Create an issue', readOnly: false },
]

function renderDialog(
  props: Partial<React.ComponentProps<typeof ConnectorReviewDialog>> = {}
) {
  const onListTools = vi.fn(async () => tools)
  render(
    <ConnectorReviewDialog
      open
      name="Linear"
      config={webService}
      onListTools={onListTools}
      onAllow={() => {}}
      onCancel={() => {}}
      {...props}
    />
  )
  return { onListTools }
}

describe('ConnectorReviewDialog', () => {
  it('shows what a local program runs and which secrets it gets, never their values', () => {
    renderDialog({ name: 'Files', config: localProgram })

    expect(screen.getByText('review:connector.program')).toBeInTheDocument()
    expect(
      screen.getByText(
        'npx -y @modelcontextprotocol/server-filesystem C:/Users/me/Documents'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('API_TOKEN')).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('secret-value')

    const warnings = screen.getByRole('list', { name: 'review:warnings' })
    expect(warnings).toHaveTextContent('review:warning.unpinnedPackage')
    expect(warnings).toHaveTextContent(
      '@modelcontextprotocol/server-filesystem'
    )
  })

  it('shows the address a web service talks to and the header names it sends', () => {
    renderDialog()

    expect(screen.getByText('review:connector.website')).toBeInTheDocument()
    expect(screen.getByText('https://mcp.linear.app/mcp')).toBeInTheDocument()
    expect(screen.getByText('Authorization')).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('Bearer abc')
    expect(
      screen.queryByRole('list', { name: 'review:warnings' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('review:noWarningsNotAGuarantee')
    ).toBeInTheDocument()
  })

  it('Preview lists a web service’s tools, split into reading and changing', async () => {
    const user = userEvent.setup()
    const { onListTools } = renderDialog()

    await user.click(screen.getByRole('button', { name: 'review:preview' }))

    const preview = await screen.findByRole('region', {
      name: 'review:previewTitle',
    })
    expect(onListTools).toHaveBeenCalledTimes(1)
    const reads = await within(preview).findByRole('list', {
      name: 'review:connector.toolsThatRead',
    })
    const changes = within(preview).getByRole('list', {
      name: 'review:connector.toolsThatChange',
    })
    expect(reads).toHaveTextContent('list_issues')
    expect(changes).toHaveTextContent('create_issue')
    // The connector labels its own tools; the screen says so.
    expect(preview).toHaveTextContent('review:connector.toolsSelfLabelled')
  })

  it('Preview of a local program shows what would run without running it', async () => {
    const user = userEvent.setup()
    const { onListTools } = renderDialog({
      name: 'Files',
      config: localProgram,
    })

    await user.click(screen.getByRole('button', { name: 'review:preview' }))

    const preview = screen.getByRole('region', { name: 'review:previewTitle' })
    expect(preview).toHaveTextContent(
      'npx -y @modelcontextprotocol/server-filesystem C:/Users/me/Documents'
    )
    expect(preview).toHaveTextContent('review:connector.listToolsRunsProgram')
    expect(onListTools).not.toHaveBeenCalled()

    await user.click(
      within(preview).getByRole('button', {
        name: 'review:connector.listTools',
      })
    )

    expect(
      await within(preview).findByRole('list', {
        name: 'review:connector.toolsThatChange',
      })
    ).toHaveTextContent('create_issue')
    expect(onListTools).toHaveBeenCalledTimes(1)
  })

  it('says so when the tools cannot be listed', async () => {
    const user = userEvent.setup()
    renderDialog({
      onListTools: vi.fn(async () => {
        throw new Error('connection refused')
      }),
    })

    await user.click(screen.getByRole('button', { name: 'review:preview' }))

    const preview = await screen.findByRole('region', {
      name: 'review:previewTitle',
    })
    expect(
      await within(preview).findByText(/review:connector\.toolsUnavailable/)
    ).toBeInTheDocument()
    expect(preview).toHaveTextContent('connection refused')
  })

  function ReviewHarness() {
    const [open, setOpen] = useState(true)
    const [outcome, setOutcome] = useState('undecided')
    return (
      <>
        <p>outcome: {outcome}</p>
        {open && (
          <ConnectorReviewDialog
            open
            name="Linear"
            config={webService}
            onListTools={async () => tools}
            onAllow={() => {
              setOutcome('allowed')
              setOpen(false)
            }}
            onCancel={() => {
              setOutcome('cancelled')
              setOpen(false)
            }}
          />
        )}
      </>
    )
  }

  const title = 'review:connectorTitle:{"name":"Linear"}'

  it('connects only when Allow is chosen', async () => {
    const user = userEvent.setup()
    render(<ReviewHarness />)

    await user.click(screen.getByRole('button', { name: 'review:allow' }))

    expect(screen.getByText('outcome: allowed')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByText(title)).not.toBeInTheDocument()
    )
  })

  it('stays disconnected when Cancel is chosen or the dialog is closed', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<ReviewHarness />)

    await user.click(screen.getByRole('button', { name: 'review:cancel' }))
    expect(screen.getByText('outcome: cancelled')).toBeInTheDocument()
    unmount()

    render(<ReviewHarness />)
    await user.keyboard('{Escape}')
    expect(screen.getByText('outcome: cancelled')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByText(title)).not.toBeInTheDocument()
    )
  })
})
