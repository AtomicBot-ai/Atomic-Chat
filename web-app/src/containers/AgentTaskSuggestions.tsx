import {
  FolderSearch,
  HardDrive,
  Newspaper,
  type LucideIcon,
} from 'lucide-react'
import { AGENT_TASK_SUGGESTIONS } from '@/constants/agent-task-suggestions'
import { useTranslation } from '@/i18n/react-i18next-compat'

const TASK_ICONS: Record<
  (typeof AGENT_TASK_SUGGESTIONS)[number]['id'],
  LucideIcon
> = {
  findLatestNews: Newspaper,
  inspectFolder: FolderSearch,
  findLargeFiles: HardDrive,
}

type AgentTaskSuggestionsProps = {
  visible: boolean
  onSelect: (prompt: string) => void
}

export function AgentTaskSuggestions({
  visible,
  onSelect,
}: AgentTaskSuggestionsProps) {
  const { t } = useTranslation()

  if (!visible) return null

  return (
    <section className="mt-4" aria-labelledby="agent-task-suggestions-title">
      <h2
        id="agent-task-suggestions-title"
        className="mb-2 px-1 text-xs font-normal text-muted-foreground/80"
      >
        {t('chat:agentTasks.title')}
      </h2>
      <div className="flex flex-col gap-0.5">
        {AGENT_TASK_SUGGESTIONS.map((task) => {
          const TaskIcon = TASK_ICONS[task.id]

          return (
            <button
              key={task.id}
              type="button"
              onClick={() => onSelect(t(task.promptKey))}
              className="group flex min-w-0 cursor-pointer items-center gap-3 rounded-lg px-1 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/80 text-muted-foreground/80">
                <TaskIcon
                  className="size-4 transition-colors group-hover:text-foreground"
                  aria-hidden="true"
                />
              </span>
              <span className="truncate text-sm font-normal">
                {t(task.titleKey)}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
