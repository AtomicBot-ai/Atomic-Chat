/**
 * MCP Service Types
 */

import { MCPTool, MCPToolCallResult } from '@janhq/core'
import type { MCPServerConfig, MCPServers, MCPSettings } from '@/hooks/useMCPServers'

export interface MCPConfig {
  mcpServers?: MCPServers
  mcpSettings?: MCPSettings
}

export interface ToolCallWithCancellationResult {
  promise: Promise<MCPToolCallResult>
  cancel: () => Promise<void>
  token: string
}

export type MCPServerStatus = {
  name: string
  status: 'connected' | 'error'
  error?: string
}

export type MCPToolsResponse = {
  tools: MCPTool[]
  servers: MCPServerStatus[]
}

/** One of a connector's tools, as the review's Preview shows it. */
export type MCPPreviewTool = {
  name: string
  description?: string
  /** What the connector says about the tool; it labels its own tools. */
  readOnly: boolean
  /** Whether the tool says it may delete or overwrite things. */
  destructive?: boolean
  /** Whether the tool says it reaches services outside this computer. */
  openWorld?: boolean
  /** The inputs the tool asks for, as the connector describes them. */
  inputSchema?: Record<string, unknown>
}

export interface MCPService {
  updateMCPConfig(configs: string): Promise<void>
  restartMCPServers(): Promise<void>
  getMCPConfig(): Promise<MCPConfig>
  getTools(): Promise<MCPTool[]>
  getToolsWithStatus(): Promise<MCPToolsResponse>
  getConnectedServers(): Promise<string[]>
  getMCPServerStatuses(): Promise<MCPServerStatus[]>
  callTool(args: { toolName: string; serverName?: string; arguments: object }): Promise<MCPToolCallResult>
  callToolWithCancellation(args: {
    toolName: string
    serverName?: string
    arguments: object
    cancellationToken?: string
  }): ToolCallWithCancellationResult
  cancelToolCall(cancellationToken: string): Promise<void>

  // MCP Server lifecycle management
  activateMCPServer(name: string, config: MCPServerConfig): Promise<void>
  deactivateMCPServer(name: string): Promise<void>
  checkJanBrowserExtensionConnected(): Promise<boolean>

  // Review before use (Task 28): the core refuses to start a connector the
  // user has not allowed as it is now.
  /** Whether the connector has to be reviewed before it can be switched on. */
  connectorNeedsReview(name: string, config: MCPServerConfig): Promise<boolean>
  /** Records the user's Allow. Does not start the connector. */
  approveConnector(name: string, config: MCPServerConfig): Promise<void>
  /** Lists the connector's tools without connecting it for the AI. */
  previewConnectorTools(
    name: string,
    config: MCPServerConfig
  ): Promise<MCPPreviewTool[]>

  // MCP OAuth browser sign-in (desktop only; tokens never reach the frontend)
  /** Opens the system browser and resolves once the callback is exchanged. */
  mcpOauthLogin(name: string, url: string): Promise<void>
  /** Abandons a sign-in that is still waiting on the browser. */
  mcpOauthCancel(): Promise<void>
  /** Forgets the stored session for a server. Missing is success. */
  mcpOauthLogout(name: string): Promise<void>
}
