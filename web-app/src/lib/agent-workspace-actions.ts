import { useAgentMode } from '@/hooks/useAgentMode'
import { resolveAgentWorkspaceRoot } from '@/services/agent/tauri'
import type { ServiceHub } from '@/services'

/**
 * Open the native directory picker and attach the chosen folder to the
 * thread's agent workspace as an editable external root. Shared by the
 * composer's "+ → Add folder" item and the workspace panel's own "+".
 */
export async function addExternalAgentFolder(
  serviceHub: ServiceHub,
  workspaceKey: string
): Promise<boolean> {
  const selected = await serviceHub.dialog().open({
    multiple: false,
    directory: true,
  })
  if (typeof selected !== 'string') return false

  const root = await resolveAgentWorkspaceRoot(selected)
  useAgentMode.getState().addExternalRoot(workspaceKey, {
    ...root,
    canEdit: true,
  })
  return true
}
