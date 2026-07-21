import { IconLoader2, IconSparkles, IconX } from '@tabler/icons-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { AgentSkill } from '@/services/agent/skills'

type AgentSkillSlashMenuProps = {
  skills: AgentSkill[]
  selectedSkill: AgentSkill | null
  activeIndex: number
  loading: boolean
  open: boolean
  onSelect: (skill: AgentSkill) => void
  onRemove: () => void
  onActiveIndexChange: (index: number) => void
}

export function AgentSkillSlashMenu({
  skills,
  selectedSkill,
  activeIndex,
  loading,
  open,
  onSelect,
  onRemove,
  onActiveIndexChange,
}: AgentSkillSlashMenuProps) {
  const { t } = useTranslation()

  return (
    <>
      {selectedSkill && (
        <div className="flex px-3 pt-3">
          <div
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs text-foreground"
            data-testid="agent-skill-chip"
          >
            <IconSparkles size={14} className="shrink-0 text-primary" />
            <span className="truncate">
              {t('common:agentSkill.selected', {
                name: selectedSkill.name,
              })}
            </span>
            <button
              type="button"
              className="rounded-full text-muted-foreground hover:text-foreground"
              aria-label={t('common:agentSkill.remove')}
              onClick={onRemove}
            >
              <IconX size={13} />
            </button>
          </div>
        </div>
      )}

      {open && (
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
                  <IconSparkles size={15} className="shrink-0 text-primary" />
                  <span className="min-w-0 truncate text-sm font-medium">
                    {skill.name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}
