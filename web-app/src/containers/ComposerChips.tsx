import { useRef, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import {
  IconBolt,
  IconGripHorizontal,
  IconMessageCode,
  IconX,
} from '@tabler/icons-react'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { AgentSkill } from '@/services/agent/skills'
import {
  MENU_DEFAULT_HEIGHT,
  useComposerLayout,
  type ComposerChip,
} from '@/stores/composer-layout-store'
import { useSavedPrompts } from '@/stores/saved-prompts-store'

/**
 * One colour per expandable pill, so each menu is recognisable at a glance:
 * Prompts is violet, Skills is amber (the model picker uses emerald).
 */
const TONES = {
  prompts:
    'border-violet-400/40 bg-violet-500/10 text-violet-600 hover:bg-violet-500/20 dark:text-violet-300',
  skills:
    'border-amber-400/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300',
} as const

const pillClass =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border pl-2.5 pr-1.5 text-xs font-medium transition-colors duration-200'

/**
 * The body of a pill menu: a grab bar along its top edge to drag it taller or
 * shorter, then a scrolling list. The menu opens above its pill, so the bar is
 * on the side that moves. Both menus share one remembered height.
 */
export function ResizableMenu({
  children,
  footer,
}: {
  children: ReactNode
  footer?: ReactNode
}) {
  const { t } = useTranslation()
  const height = useComposerLayout((state) => state.menuHeight)
  const setHeight = useComposerLayout((state) => state.setMenuHeight)
  const drag = useRef<{ y: number; height: number } | null>(null)

  return (
    <div className="flex flex-col" style={{ height }}>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('chat:chips.resizeMenu', {
          defaultValue: 'Drag to resize this menu (double-click to reset)',
        })}
        title={t('chat:chips.resizeMenu', {
          defaultValue: 'Drag to resize this menu (double-click to reset)',
        })}
        data-no-hover-glow
        data-testid="menu-resize-grip"
        className="flex h-4 shrink-0 cursor-ns-resize touch-none items-center justify-center text-muted-foreground/60 hover:text-foreground"
        onPointerDown={(event) => {
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { y: event.clientY, height }
        }}
        onPointerMove={(event) => {
          if (drag.current) {
            // Up is taller: the menu's bottom edge is fixed to its pill.
            setHeight(drag.current.height + (drag.current.y - event.clientY))
          }
        }}
        onPointerUp={(event) => {
          drag.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onDoubleClick={() => setHeight(MENU_DEFAULT_HEIGHT)}
      >
        <IconGripHorizontal size={14} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      {footer}
    </div>
  )
}

function RemoveButton({ chip, label }: { chip: ComposerChip; label: string }) {
  const removeChip = useComposerLayout((state) => state.removeChip)
  return (
    <button
      type="button"
      aria-label={label}
      data-no-hover-glow
      className="rounded-full p-0.5 opacity-70 hover:opacity-100"
      onClick={(event) => {
        event.stopPropagation()
        removeChip(chip)
      }}
    >
      <IconX size={12} />
    </button>
  )
}

function PromptsChip({ onInsert }: { onInsert: (text: string) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const prompts = useSavedPrompts((state) => state.prompts)

  const shown = prompts.filter((prompt) => prompt.showInComposer)
  const groups = [
    {
      key: 'agent',
      label: t('chat:chips.agentPrompts', { defaultValue: 'Agent prompts' }),
      items: shown.filter((prompt) => prompt.category === 'agent'),
    },
    {
      key: 'chat',
      label: t('chat:chips.basicPrompts', { defaultValue: 'Basic prompts' }),
      items: shown.filter((prompt) => prompt.category === 'chat'),
    },
  ].filter((group) => group.items.length > 0)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn(pillClass, TONES.prompts)}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="composer-chip-prompts"
            data-no-hover-glow
            className="inline-flex items-center gap-1.5"
          >
            <IconMessageCode size={14} />
            {t('chat:chips.prompts', { defaultValue: 'Prompts' })}
          </button>
        </PopoverTrigger>
        <RemoveButton
          chip="prompts"
          label={t('chat:chips.remove', { defaultValue: 'Remove from toolbar' })}
        />
      </div>
      <PopoverContent
        align="start"
        side="top"
        className="w-80 max-w-[calc(100vw-2rem)] p-1.5"
      >
        <ResizableMenu
          footer={
            <div className="mt-1 flex items-center justify-between border-t px-2 pt-2 pb-1 text-[11px] text-muted-foreground">
              <span>
                {t('chat:chips.synced', {
                  defaultValue: 'Synced with Settings › Prompts',
                })}
              </span>
              <Link
                to={route.settings.prompts}
                className="text-violet-600 dark:text-violet-300"
                onClick={() => setOpen(false)}
              >
                {t('chat:chips.manage', { defaultValue: 'Manage' })}
              </Link>
            </div>
          }
        >
          {groups.length === 0 && (
            <p className="p-2 text-xs text-muted-foreground">
              {t('chat:chips.noPrompts', {
                defaultValue:
                  'No prompts are shown here. Add or switch some on in Settings › Prompts.',
              })}
            </p>
          )}
          {groups.map((group) => (
            <div key={group.key}>
              <p className="px-2 pt-2 pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                {group.label}
              </p>
              {group.items.map((prompt) => (
                <button
                  key={prompt.id}
                  type="button"
                  data-no-hover-glow
                  className="flex w-full flex-col rounded-lg px-2 py-1.5 text-left hover:bg-accent"
                  onClick={() => {
                    onInsert(prompt.body)
                    setOpen(false)
                  }}
                >
                  <span className="truncate text-xs font-medium">
                    {prompt.title}
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {prompt.description || prompt.body.trim()}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </ResizableMenu>
      </PopoverContent>
    </Popover>
  )
}

function SkillsChip({
  skills,
  selected,
  onPick,
}: {
  skills: AgentSkill[]
  selected: AgentSkill | null
  onPick: (skill: AgentSkill | null) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn(pillClass, TONES.skills)}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="composer-chip-skills"
            data-no-hover-glow
            className="inline-flex items-center gap-1.5"
          >
            <IconBolt size={14} />
            {selected
              ? selected.name
              : t('chat:chips.skills', { defaultValue: 'Skills' })}
          </button>
        </PopoverTrigger>
        <RemoveButton
          chip="skills"
          label={t('chat:chips.remove', { defaultValue: 'Remove from toolbar' })}
        />
      </div>
      <PopoverContent
        align="start"
        side="top"
        className="w-80 max-w-[calc(100vw-2rem)] p-1.5"
      >
        <ResizableMenu>
          {skills.length === 0 && (
            <p className="p-2 text-xs text-muted-foreground">
              {t('chat:chips.noSkills', {
                defaultValue:
                  'No skills are switched on. Turn some on under Plugins › Skills.',
              })}
            </p>
          )}
          {selected && (
            <button
              type="button"
              data-no-hover-glow
              className="w-full rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent"
              onClick={() => {
                onPick(null)
                setOpen(false)
              }}
            >
              {t('chat:chips.clearSkill', { defaultValue: 'Don’t use a skill' })}
            </button>
          )}
          {skills.map((skill) => (
            <button
              key={skill.name}
              type="button"
              data-no-hover-glow
              className={cn(
                'w-full rounded-lg px-2 py-1.5 text-left hover:bg-accent',
                selected?.name === skill.name && 'bg-accent'
              )}
              onClick={() => {
                onPick(skill)
                setOpen(false)
              }}
            >
              <div className="truncate text-xs font-medium">{skill.name}</div>
              <div className="line-clamp-2 text-[11px] text-muted-foreground">
                {skill.description}
              </div>
            </button>
          ))}
        </ResizableMenu>
      </PopoverContent>
    </Popover>
  )
}

/** The feature chips the "+" menu added, as pills beside the model picker. */
export function ComposerChips({
  onInsertPrompt,
  skills,
  selectedSkill,
  onPickSkill,
}: {
  onInsertPrompt: (text: string) => void
  skills: AgentSkill[]
  selectedSkill: AgentSkill | null
  onPickSkill: (skill: AgentSkill | null) => void
}) {
  const chips = useComposerLayout((state) => state.chips)
  return (
    <>
      {chips.includes('prompts') && <PromptsChip onInsert={onInsertPrompt} />}
      {chips.includes('skills') && (
        <SkillsChip
          skills={skills}
          selected={selectedSkill}
          onPick={onPickSkill}
        />
      )}
    </>
  )
}
