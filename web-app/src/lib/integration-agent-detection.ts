import { invoke } from '@tauri-apps/api/core'
import {
  INTEGRATION_AGENTS,
  type IntegrationAgent,
} from '@/constants/integrations'
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

let detectedThisSession = false

/**
 * One detection pass per app session for surfaces that only show status (the
 * Server sidebar). The Launch page re-detects on every visit and after each
 * install, so a stale answer here is refreshed there.
 */
export function detectIntegrationAgentsOnce() {
  if (detectedThisSession) return
  detectedThisSession = true
  const { installed } = useLaunchStore.getState()
  const { customPaths } = useLaunchSettings.getState()
  INTEGRATION_AGENTS.forEach((agent) => {
    if (installed[agent.id] !== undefined) return
    void detectIntegrationAgent(agent, customPaths[agent.id])
  })
}
