import { IconFolderPlus } from '@tabler/icons-react'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { resolveAgentWorkspaceRoot } from '@/services/agent/tauri'

type AgentExternalFolderButtonProps = {
  workspaceKey: string
  onAdded?: () => void
}

export function AgentExternalFolderButton({
  workspaceKey,
  onAdded,
}: AgentExternalFolderButtonProps) {
  const serviceHub = useServiceHub()
  const { t } = useTranslation('chat')

  const addFolder = async () => {
    const selected = await serviceHub.dialog().open({
      multiple: false,
      directory: true,
    })
    if (typeof selected !== 'string') return

    const root = await resolveAgentWorkspaceRoot(selected)
    useAgentMode.getState().addExternalRoot(workspaceKey, {
      ...root,
      canEdit: true,
    })
    onAdded?.()
  }

  return (
    <button
      type="button"
      className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={t('agentWorkspace.addFolder')}
      aria-label={t('agentWorkspace.addFolder')}
      onClick={() => void addFolder()}
    >
      <IconFolderPlus className="size-4" />
    </button>
  )
}
