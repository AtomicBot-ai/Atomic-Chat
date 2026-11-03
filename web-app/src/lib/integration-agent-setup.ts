import { invoke } from '@tauri-apps/api/core'

import type { IntegrationAgent } from '@/constants/integrations'

/** The Local API Server settings an agent's config points at. */
export type AgentServerSettings = {
  serverHost: string
  serverPort: number
  apiPrefix: string
  apiKey: string
}

/**
 * The address an agent dials. The server may listen on a bind-all address
 * (0.0.0.0 / ::) that clients cannot connect to; agents need loopback.
 */
export function agentConnectHost(serverHost: string): string {
  return serverHost === '0.0.0.0' || serverHost === '::'
    ? '127.0.0.1'
    : serverHost
}

/** The base URL written into an agent's config, with the prefix if it wants one. */
export function agentApiUrl(
  agent: IntegrationAgent,
  { serverHost, serverPort, apiPrefix }: AgentServerSettings
): string {
  const base = `http://${agentConnectHost(serverHost)}:${serverPort}`
  return agent.endpointWithPrefix ? `${base}${apiPrefix}` : base
}

/**
 * Agents the Server setup guide can connect by itself: Atomic Chat writes
 * their config. Editors set up by hand stay on All integrations.
 */
export const isGuidedAgent = (agent: IntegrationAgent): boolean =>
  agent.configurable && !agent.editor

/** What the app knows about the served model beyond its id. */
export type AgentConfigOptions = {
  /**
   * The window the served model was loaded with: agents told nothing assume
   * 128K-272K and never compact before a 16K-64K local server refuses.
   */
  contextLength?: number
}

/**
 * Writes the agent's own config so it uses the Local API Server: its URL,
 * the model, the key and, when known, the model's context window. Throws
 * when the agent is unknown or the write fails, so the caller reports one
 * error.
 */
export async function writeAgentConfig(
  agent: IntegrationAgent,
  model: string | null,
  server: AgentServerSettings,
  options: AgentConfigOptions = {}
): Promise<void> {
  const apiUrl = agentApiUrl(agent, server)
  const apiKey = server.apiKey || undefined
  const contextLength = options.contextLength ?? null

  switch (agent.id) {
    case 'claude-code':
      await invoke('configure_claude_code', {
        apiUrl,
        model: model ?? undefined,
        apiKey,
        contextLength,
      })
      break
    case 'codex':
      await invoke('configure_codex', {
        apiUrl,
        model,
        apiKey,
        contextLength,
      })
      break
    case 'opencode':
      await invoke('configure_opencode', {
        apiUrl,
        model,
        apiKey,
        contextLength,
      })
      break
    case 'openclaude':
      await invoke('configure_openclaude', {
        apiUrl,
        model,
        apiKey,
        contextLength,
      })
      break
    case 'cline':
      await invoke('configure_cline', {
        apiUrl,
        model,
        apiKey,
        contextLength,
      })
      break
    case 'mimo':
      await invoke('configure_mimo', {
        apiUrl,
        model,
        apiKey,
        contextLength,
      })
      break
    case 'zed':
      await invoke('configure_zed', {
        apiUrl,
        model,
        apiKey,
        contextLength,
      })
      break
    case 'zcode':
      await invoke('configure_zcode', {
        apiUrl,
        model,
        apiKey,
        contextLength,
      })
      break
    case 'copilot':
      await invoke('configure_copilot', {
        apiUrl,
        model,
        apiKey,
        contextLength,
      })
      break
    case 'droid':
      await invoke('configure_droid', {
        apiUrl,
        model,
        apiKey,
        contextLength,
      })
      break
    case 'atomic-agent':
      await invoke('configure_atomic_agent', {
        apiUrl,
        model,
        apiKey,
        contextLength,
      })
      break
    case 'hermes':
      await invoke('configure_hermes_agent', {
        apiUrl,
        model,
        apiKey,
        // Hermes Agent refuses to start below a 64K context window, so we
        // configure 64K (the minimum it accepts).
        contextLength: 65536,
      })
      break
    case 'pi':
      await invoke('configure_pi', {
        apiUrl,
        model,
        apiKey,
        contextLength,
      })
      break
    case 'goose':
      await invoke('configure_goose', {
        apiUrl,
        model,
        apiKey,
        contextLength,
      })
      break
    case 'openhands':
      await invoke('configure_openhands', {
        apiUrl,
        model,
        apiKey,
        contextLength,
      })
      break
    case 'kilo':
      await invoke('configure_kilo', {
        apiUrl,
        model,
        apiKey,
        contextLength,
      })
      break
    case 'poolside':
      await invoke('configure_poolside', {
        apiUrl,
        model,
        apiKey,
        contextLength,
      })
      break
    case 'muse':
      await invoke('configure_muse', {
        apiUrl,
        model,
        apiKey,
        contextLength,
      })
      break
    case 'openclaw':
      await invoke('configure_openclaw', {
        apiUrl,
        model,
        apiKey,
        contextLength,
      })
      break
    case 'dsh':
      await invoke('configure_dsh', {
        apiUrl,
        model,
        apiKey,
        contextLength,
      })
      break
    default:
      throw new Error(`Unknown agent: ${agent.id}`)
  }
}

/** The description of the "configured" toast: some agents pick it up live. */
export function agentConfiguredDescriptionKey(agentId: string): string {
  return agentId === 'zed'
    ? 'launch:toast.configuredDescEditor'
    : agentId === 'openclaw'
      ? // OpenClaw's Gateway watches the config file and hot-reloads, so
        // there is nothing to restart — but a chat that was already pinned
        // to another model keeps it, and only `/model default` clears that.
        'launch:toast.configuredDescOpenclaw'
      : agentId === 'zcode'
        ? // ZCode polls its provider file, so a running app switches over
          // without a restart.
          'launch:toast.configuredDescZcode'
        : agentId === 'codex'
          ? // Only `codex --profile atomic-chat` uses the local server; say
            // so, since a plain `codex` no longer does.
            'launch:toast.configuredDescCodex'
          : 'launch:toast.configuredDesc'
}
