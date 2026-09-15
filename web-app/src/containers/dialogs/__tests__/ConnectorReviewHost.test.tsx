import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ConnectorReviewHost from '../ConnectorReviewHost'
import { useConnectorReview } from '@/hooks/useConnectorReview'
import type { MCPServerConfig } from '@/hooks/useMCPServers'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

const previewConnectorTools = vi.hoisted(() => vi.fn())
const activateMCPServer = vi.hoisted(() => vi.fn())
const mcp = () => ({ previewConnectorTools, activateMCPServer })

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ mcp }),
  getServiceHub: () => ({ mcp }),
}))

/**
 * Task 28 (decision D36): one review host serves every screen that switches a
 * connector on - the Connectors page, the chat's connectors menu, the web
 * search button and the browser button.
 */

const linear: MCPServerConfig = {
  command: '',
  args: [],
  env: {},
  type: 'http',
  url: 'https://mcp.linear.app/mcp',
}

const files: MCPServerConfig = {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem@2026.1.14'],
  env: {},
}

const titleFor = (name: string) =>
  `review:connectorTitle:${JSON.stringify({ name })}`

describe('ConnectorReviewHost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useConnectorReview.setState({ pending: [] })
    previewConnectorTools.mockResolvedValue([
      { name: 'list_issues', readOnly: true },
      { name: 'create_issue', readOnly: false },
    ])
  })

  it('shows nothing while no connector is waiting', () => {
    const { container } = render(<ConnectorReviewHost />)

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('reviews waiting connectors one at a time and answers each choice', async () => {
    const user = userEvent.setup()
    render(<ConnectorReviewHost />)

    let first!: Promise<boolean>
    let second!: Promise<boolean>
    act(() => {
      first = useConnectorReview.getState().requestReview('linear', linear)
      second = useConnectorReview.getState().requestReview('files', files)
    })

    expect(await screen.findByText(titleFor('linear'))).toBeInTheDocument()
    expect(screen.queryByText(titleFor('files'))).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'review:allow' }))
    await expect(first).resolves.toBe(true)

    expect(await screen.findByText(titleFor('files'))).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'review:cancel' }))
    await expect(second).resolves.toBe(false)

    await waitFor(() =>
      expect(screen.queryByText(titleFor('files'))).not.toBeInTheDocument()
    )
    expect(useConnectorReview.getState().pending).toEqual([])
    expect(activateMCPServer).not.toHaveBeenCalled()
  })

  it('Preview lists the tools through the core without connecting anything', async () => {
    const user = userEvent.setup()
    render(<ConnectorReviewHost />)
    act(() => {
      void useConnectorReview.getState().requestReview('linear', linear)
    })

    await user.click(
      await screen.findByRole('button', { name: 'review:preview' })
    )

    const preview = screen.getByRole('region', { name: 'review:previewTitle' })
    expect(
      await within(preview).findByRole('list', {
        name: 'review:connector.toolsThatChange',
      })
    ).toHaveTextContent('create_issue')
    expect(previewConnectorTools).toHaveBeenCalledWith('linear', linear)
    expect(activateMCPServer).not.toHaveBeenCalled()
    // Preview is not a choice: the connector is still waiting.
    expect(useConnectorReview.getState().pending).toHaveLength(1)
  })
})
