import { invoke } from '@tauri-apps/api/core'
import {
  INTEGRATION_AGENTS,
  type IntegrationAgent,
} from '@/constants/integrations'
import { useServerSetup } from '@/hooks/useServerSetup'
import { useLaunchStore } from '@/stores/launch-store'
import { useLaunchSettings } from '@/stores/launch-settings-store'

type Detection = {
  installed: boolean
  viaWsl: boolean
  path?: string | null
}

function record(
  agentId: string,
  installed: boolean,
  viaWsl: boolean,
  path: string | undefined
) {
  const store = useLaunchStore.getState()
  store.setInstalled((prev) => ({ ...prev, [agentId]: installed }))
  store.setViaWsl((prev) => ({ ...prev, [agentId]: viaWsl }))
  // Only set for launchers found off PATH (a custom path, or a prefix
  // install like OpenClaw's app-managed `~/.openclaw/bin/openclaw`), where
  // the bare binary name would not resolve in the terminal we open.
  store.setBinPath((prev) => ({ ...prev, [agentId]: path }))
}

/**
 * Asks the shell whether an integration agent is installed and records the
 * answer in the Launch store, which the Launch page and the Server sidebar
 * both read.
 */
export async function detectIntegrationAgent(
  agent: IntegrationAgent,
  customPath?: string
): Promise<boolean> {
  try {
    const result = await invoke<Detection>('detect_agent_installed', {
      bin: agent.detectBin,
      customPath: customPath || null,
    })
    record(agent.id, result.installed, result.viaWsl, result.path ?? undefined)
    return result.installed
  } catch {
    record(agent.id, false, false, undefined)
    return false
  }
}

/**
 * Lists the agents whose own config already points at this server — set up
 * through an earlier release, before the Server section kept its list — as
 * configured. When the backend cannot tell, the list stays as it is.
 */
export async function adoptConfiguredAgents(): Promise<void> {
  try {
    const ids = await invoke<string[]>('detect_configured_agents')
    const known = new Set(INTEGRATION_AGENTS.map((agent) => agent.id))
    useServerSetup.getState().adoptAgents(ids.filter((id) => known.has(id)))
  } catch {
    // Nothing found is the same as nothing configured.
  }
}

let detectedThisSession = false

/**
 * One detection pass per app session for surfaces that only show status (the
 * Server sidebar): what is installed, and what is already set up. The
 * Launch page re-detects installs on every visit and after each install, so a
 * stale answer here is refreshed there.
 */
export function detectIntegrationAgentsOnce() {
  if (detectedThisSession) return
  detectedThisSession = true
  void adoptConfiguredAgents()
  const { installed } = useLaunchStore.getState()
  const { customPaths } = useLaunchSettings.getState()
  INTEGRATION_AGENTS.forEach((agent) => {
    if (installed[agent.id] !== undefined) return
    void detectIntegrationAgent(agent, customPaths[agent.id])
  })
}
