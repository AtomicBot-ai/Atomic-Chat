import type { MCPTool } from '@/types/completion'
import { TOOL_TEMPLATE_OVERHEAD_TOKENS, estimateTokens } from '@/lib/prompt-size'

/**
 * A single connector whose tool definitions alone take more than this share
 * of the context window is flagged "heavy". 10% is where Claude Code's
 * `auto` tool search and Cherry Studio's deferral kick in; on a 16k window
 * that is ~1.6k tokens.
 */
export const HEAVY_SERVER_CTX_SHARE = 0.1
/**
 * Total tool definitions above this share of the window trigger the
 * composer hint: prefill of that much boilerplate on every cold request is
 * what makes a local model feel slow.
 */
export const HEAVY_TOOLS_CTX_SHARE = 0.25

export type ServerToolCost = {
  server: string
  toolCount: number
  tokens: number
  /** Share of the context window, `undefined` when the window is unknown. */
  ctxShare?: number
  heavy: boolean
}

export type ToolCostReport = {
  totalTokens: number
  toolCount: number
  ctxLen?: number
  ctxShare?: number
  perServer: ServerToolCost[]
  /** Servers over `HEAVY_SERVER_CTX_SHARE`, largest first. */
  heavyServers: string[]
  /** Total over `HEAVY_TOOLS_CTX_SHARE`, or any heavy server. */
  tooHeavy: boolean
}

/** Rough prompt cost of one MCP tool definition as the chat template renders it. */
export function estimateMcpToolTokens(tool: MCPTool): number {
  const rendered = JSON.stringify({
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.inputSchema ?? {},
  })
  return estimateTokens(rendered) + TOOL_TEMPLATE_OVERHEAD_TOKENS
}

/**
 * Per-server token cost of a tool set. Pure bookkeeping: nothing is trimmed
 * or dropped here — the numbers feed the plugins menu and telemetry so the
 * user can decide what to switch off for a chat.
 */
export function summarizeToolCost(
  tools: readonly MCPTool[],
  ctxLen: number | undefined
): ToolCostReport {
  const byServer = new Map<string, { toolCount: number; tokens: number }>()
  for (const tool of tools) {
    const server = tool.server || 'unknown'
    const entry = byServer.get(server) ?? { toolCount: 0, tokens: 0 }
    entry.toolCount += 1
    entry.tokens += estimateMcpToolTokens(tool)
    byServer.set(server, entry)
  }

  const share = (tokens: number) =>
    ctxLen && ctxLen > 0 ? tokens / ctxLen : undefined

  const perServer: ServerToolCost[] = [...byServer.entries()]
    .map(([server, { toolCount, tokens }]) => {
      const ctxShare = share(tokens)
      return {
        server,
        toolCount,
        tokens,
        ctxShare,
        heavy: ctxShare !== undefined && ctxShare > HEAVY_SERVER_CTX_SHARE,
      }
    })
    .sort((a, b) => b.tokens - a.tokens || a.server.localeCompare(b.server))

  const totalTokens = perServer.reduce((sum, s) => sum + s.tokens, 0)
  const totalShare = share(totalTokens)
  const heavyServers = perServer.filter((s) => s.heavy).map((s) => s.server)

  return {
    totalTokens,
    toolCount: tools.length,
    ctxLen,
    ctxShare: totalShare,
    perServer,
    heavyServers,
    tooHeavy:
      heavyServers.length > 0 ||
      (totalShare !== undefined && totalShare > HEAVY_TOOLS_CTX_SHARE),
  }
}

/** Compact "≈ 1.2k" formatting for token counts in the UI. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(tokens)
}
