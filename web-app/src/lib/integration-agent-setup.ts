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

/**
 * Writes the agent's own config so it uses the Local API Server: its URL,
 * the model and the key. Throws when the agent is unknown or the write
 * fails, so the caller reports one error.
 */
export async function writeAgentConfig(
  agent: IntegrationAgent,
  model: string | null,
  server: AgentServerSettings
): Promise<void> {
  const apiUrl = agentApiUrl(agent, server)
  const apiKey = server.apiKey || undefined

  switch (agent.id) {
    case 'claude-code':
      await invoke('configure_claude_code', {
        apiUrl,
        model: model ?? undefined,
        apiKey,
      })
      break
    case 'codex':
      await invoke('configure_codex', { apiUrl, model, apiKey })
      break
    case 'opencode':
      await invoke('configure_opencode', { apiUrl, model, apiKey })
      break
    case 'openclaude':
      await invoke('configure_openclaude', { apiUrl, model, apiKey })
      break
    case 'cline':
      await invoke('configure_cline', { apiUrl, model, apiKey })
      break
    case 'mimo':
      await invoke('configure_mimo', { apiUrl, model, apiKey })
      break
    case 'zed':
      await invoke('configure_zed', { apiUrl, model, apiKey })
      break
    case 'zcode':
      await invoke('configure_zcode', { apiUrl, model, apiKey })
      break
    case 'copilot':
      await invoke('configure_copilot', { apiUrl, model, apiKey })
      break
    case 'droid':
      await invoke('configure_droid', { apiUrl, model, apiKey })
      break
    case 'atomic-agent':
      await invoke('configure_atomic_agent', { apiUrl, model, apiKey })
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
      await invoke('configure_pi', { apiUrl, model, apiKey })
      break
    case 'goose':
      await invoke('configure_goose', { apiUrl, model, apiKey })
      break
    case 'openhands':
      await invoke('configure_openhands', { apiUrl, model, apiKey })
      break
    case 'kilo':
      await invoke('configure_kilo', { apiUrl, model, apiKey })
      break
    case 'poolside':
      await invoke('configure_poolside', { apiUrl, model, apiKey })
      break
    case 'muse':
      await invoke('configure_muse', { apiUrl, model, apiKey })
      break
    case 'stack-agent':
      await invoke('configure_stack_agent', { apiUrl, model, apiKey })
      break
    case 'openclaw':
      await invoke('configure_openclaw', { apiUrl, model, apiKey })
      break
    case 'dsh':
      await invoke('configure_dsh', { apiUrl, model, apiKey })
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
        : 'launch:toast.configuredDesc'
}
