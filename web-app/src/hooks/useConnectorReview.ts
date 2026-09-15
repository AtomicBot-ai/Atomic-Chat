import { create } from 'zustand'

import type { MCPServerConfig } from '@/hooks/useMCPServers'
import type { MCPService } from '@/services/mcp/types'

export type ConnectorReviewRequest = {
  id: number
  name: string
  config: MCPServerConfig
}

type PendingReview = ConnectorReviewRequest & {
  resolve: (allowed: boolean) => void
}

type ConnectorReviewState = {
  /** Connectors waiting for Allow or Cancel, oldest first. */
  pending: PendingReview[]
  requestReview: (name: string, config: MCPServerConfig) => Promise<boolean>
  settle: (id: number, allowed: boolean) => void
}

/**
 * Review before use for MCP connectors (Task 28, decision D36). Any screen
 * that switches a connector on asks here first; ConnectorReviewHost shows the
 * review for the oldest waiting connector.
 */
let nextReviewId = 1

export const useConnectorReview = create<ConnectorReviewState>()(
  (set, get) => ({
    pending: [],
    requestReview: (name, config) =>
      new Promise<boolean>((resolve) => {
        const id = nextReviewId++
        set((state) => ({
          pending: [...state.pending, { id, name, config, resolve }],
        }))
      }),
    settle: (id, allowed) => {
      const request = get().pending.find((candidate) => candidate.id === id)
      if (!request) return
      set((state) => ({
        pending: state.pending.filter((candidate) => candidate.id !== id),
      }))
      request.resolve(allowed)
    },
  })
)

/**
 * Resolves true when the connector may be switched on: it was already
 * reviewed as it is now, or the user just chose Allow (which is recorded).
 * Resolves false when the user chose Cancel.
 */
export async function ensureConnectorReviewed(
  mcp: Pick<MCPService, 'connectorNeedsReview' | 'approveConnector'>,
  name: string,
  config: MCPServerConfig
): Promise<boolean> {
  if (!(await mcp.connectorNeedsReview(name, config))) return true
  const allowed = await useConnectorReview
    .getState()
    .requestReview(name, config)
  if (allowed) await mcp.approveConnector(name, config)
  return allowed
}
