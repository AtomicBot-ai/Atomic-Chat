import { IconLoader2 } from '@tabler/icons-react'
import { FileTextIcon } from '@/components/animated-icon/file-text'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { AgentSkill } from '@/services/agent/skills'

type AgentSkillSlashMenuProps = {
  skills: AgentSkill[]
  activeIndex: number
  loading: boolean
  open: boolean
  onSelect: (skill: AgentSkill) => void
  onActiveIndexChange: (index: number) => void
}

export function AgentSkillSlashMenu({
  skills,
  activeIndex,
  loading,
  open,
  onSelect,
  onActiveIndexChange,
}: AgentSkillSlashMenuProps) {
  const { t } = useTranslation()

  if (!open) return null

  return (
    <div
      className="absolute bottom-full left-3 z-50 mb-2 w-64 max-w-[calc(100%-1.5rem)] overflow-hidden rounded-xl border bg-popover shadow-lg"
      data-testid="agent-skill-slash-menu"
      role="listbox"
    >
      {loading ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
          <IconLoader2 size={14} className="animate-spin" />
          {t('common:agentSkill.loading')}
        </div>
      ) : skills.length === 0 ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">
          {t('common:agentSkill.noMatches')}
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto p-1">
          {skills.map((skill, index) => (
            <button
              key={skill.name}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${
                index === activeIndex
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/60'
              }`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onActiveIndexChange(index)}
              onClick={() => onSelect(skill)}
            >
              <FileTextIcon
                active={index === activeIndex}
                size={15}
                className="shrink-0 text-primary"
              />
              <span className="min-w-0 truncate text-sm font-medium">
                {skill.name}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
