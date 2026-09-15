import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ensureConnectorReviewed,
  useConnectorReview,
} from '../useConnectorReview'
import type { MCPServerConfig } from '@/hooks/useMCPServers'

/**
 * Task 28 (decision D36): every screen that switches a connector on asks for a
 * review first. Only Allow is recorded; Cancel leaves the connector off and
 * unreviewed.
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

function fakeCore(needsReview: boolean) {
  return {
    connectorNeedsReview: vi.fn(async () => needsReview),
    approveConnector: vi.fn(async () => {}),
  }
}

const pendingNames = () =>
  useConnectorReview.getState().pending.map((request) => request.name)

describe('ensureConnectorReviewed', () => {
  beforeEach(() => {
    useConnectorReview.setState({ pending: [] })
  })

  it('lets an already reviewed connector through without asking', async () => {
    const core = fakeCore(false)

    await expect(ensureConnectorReviewed(core, 'linear', linear)).resolves.toBe(
      true
    )

    expect(pendingNames()).toEqual([])
    expect(core.approveConnector).not.toHaveBeenCalled()
  })

  it('asks, and records the review only when Allow is chosen', async () => {
    const core = fakeCore(true)

    const decision = ensureConnectorReviewed(core, 'linear', linear)
    await vi.waitFor(() => expect(pendingNames()).toEqual(['linear']))
    expect(useConnectorReview.getState().pending[0].config).toEqual(linear)
    expect(core.approveConnector).not.toHaveBeenCalled()

    const [request] = useConnectorReview.getState().pending
    useConnectorReview.getState().settle(request.id, true)

    await expect(decision).resolves.toBe(true)
    expect(core.approveConnector).toHaveBeenCalledWith('linear', linear)
    expect(pendingNames()).toEqual([])
  })

  it('leaves the connector unreviewed when Cancel is chosen', async () => {
    const core = fakeCore(true)

    const decision = ensureConnectorReviewed(core, 'linear', linear)
    await vi.waitFor(() => expect(pendingNames()).toEqual(['linear']))
    const [request] = useConnectorReview.getState().pending
    useConnectorReview.getState().settle(request.id, false)

    await expect(decision).resolves.toBe(false)
    expect(core.approveConnector).not.toHaveBeenCalled()
    expect(pendingNames()).toEqual([])
  })

  it('reviews several connectors one at a time, oldest first', async () => {
    const core = fakeCore(true)

    const first = ensureConnectorReviewed(core, 'linear', linear)
    const second = ensureConnectorReviewed(core, 'files', files)
    await vi.waitFor(() => expect(pendingNames()).toEqual(['linear', 'files']))

    useConnectorReview
      .getState()
      .settle(useConnectorReview.getState().pending[0].id, true)
    await expect(first).resolves.toBe(true)
    expect(pendingNames()).toEqual(['files'])

    useConnectorReview
      .getState()
      .settle(useConnectorReview.getState().pending[0].id, false)
    await expect(second).resolves.toBe(false)
    expect(core.approveConnector.mock.calls).toEqual([['linear', linear]])
  })
})
