import { FolderOpen } from 'lucide-react'
import { getJanDataFolderPath } from '@janhq/core'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'

const DEFAULT_AGENT_WORKSPACE_DIR = 'agent-workspace'

type AgentWorkspaceSelectProps = {
  workingDir?: string
  onChange: (workingDir: string) => void
}

export function AgentWorkspaceSelect({
  workingDir,
  onChange,
}: AgentWorkspaceSelectProps) {
  const serviceHub = useServiceHub()
  const { t } = useTranslation('chat')

  const chooseWorkspace = async () => {
    const defaultPath =
      workingDir ??
      (await serviceHub
        .path()
        .join(await getJanDataFolderPath(), DEFAULT_AGENT_WORKSPACE_DIR))
    const selected = await serviceHub.dialog().open({
      multiple: false,
      directory: true,
      defaultPath,
    })
    if (typeof selected === 'string') {
      onChange(selected)
    }
  }

  return (
    <button
      type="button"
      className="flex max-w-48 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={workingDir ?? t('agentWorkspace.defaultDescription')}
      aria-label={
        workingDir ? t('agentWorkspace.change') : t('agentWorkspace.choose')
      }
      onClick={() => void chooseWorkspace()}
    >
      <FolderOpen className="size-4 shrink-0" />
      <span className="truncate">
        {workingDir
          ? workingDir.split(/[\\/]/).filter(Boolean).at(-1) || workingDir
          : t('agentWorkspace.default')}
      </span>
    </button>
  )
}
