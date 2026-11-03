import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconChevronDown,
  IconClipboardText,
  IconDots,
  IconDownload,
  IconEdit,
  IconMessage,
  IconRefresh,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react'
import { toast } from 'sonner'
import HeaderPage from '@/containers/HeaderPage'
import { AgentSkillCreateDialog } from '@/containers/AgentSkillCreateDialog'
import { AgentSkillEditDialog } from '@/containers/AgentSkillEditDialog'
import { AgentSkillUploadDialog } from '@/containers/AgentSkillUploadDialog'
import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { route } from '@/constants/routes'
import { useAgentSkills } from '@/hooks/useAgentSkills'
import {
  useStackedListDetail,
  type ListDetailGeometry,
} from '@/hooks/useStackedListDetail'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { AgentSkill, AgentSkillDetail } from '@/services/agent/skills'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.skills.index as any)({
  component: SkillsPage,
})

/**
 * Below this the instructions stop fitting beside the list, and the page
 * becomes list → detail. See docs/decisions/
 * 2026-10-22-stack-the-skills-list-and-instructions-when-the-page-is-narrow.md.
 */
const SKILLS_LAYOUT: ListDetailGeometry = {
  // `minmax(260px, 360px)` resolves to its maximum whenever the detail fits.
  listWidth: 360,
  // The detail pane's `p-3` and the card's `p-4` and 1 px border, both sides.
  detailInset: 2 * (12 + 16 + 1),
  // About 65–70 characters of Inter at the body size: a comfortable line.
  detailMeasureEm: 36,
}

export function SkillsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const {
    skills,
    selected,
    loading,
    error,
    load,
    select,
    setEnabled,
    addCreated,
    addImported,
    remove,
    update,
    exportSkill,
  } = useAgentSkills()
  const [deleteName, setDeleteName] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const { ref: pageRef, stacked } =
    useStackedListDetail<HTMLDivElement>(SKILLS_LAYOUT)
  // The skill the user opened from the list. Stacked, the page shows its
  // instructions full-width once they have loaded, and the list otherwise.
  const [openedName, setOpenedName] = useState<string | null>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  // Stacked, one view replaces the other and the focused control goes with
  // it: focus lands on Back after opening, and on the skill's row after Back.
  // A deleted skill's row hands focus to its neighbour, or to the list.
  const pendingFocus = useRef<{ row: string } | 'back' | 'list' | null>(null)

  const detailOpen =
    stacked && selected !== null && selected.name === openedName
  const showList = !stacked || !detailOpen
  const showDetail = !stacked || detailOpen

  useEffect(() => {
    const target = pendingFocus.current
    if (!target) return
    const element =
      target === 'back'
        ? backRef.current
        : target === 'list'
          ? listRef.current
          : rowRefs.current.get(target.row)
    element?.focus()
    // A dialog that is still open holds focus inside itself; try again on
    // the render that closes it.
    if (element && document.activeElement === element) {
      pendingFocus.current = null
    }
  })

  const openSkill = (name: string) => {
    pendingFocus.current = stacked ? 'back' : null
    setOpenedName(name)
    void select(name)
  }

  const closeSkill = () => {
    pendingFocus.current = openedName ? { row: openedName } : null
    setOpenedName(null)
  }

  // A skill just written or uploaded opens as if picked from the list.
  const openAdded = async (adding: Promise<AgentSkillDetail>) => {
    const detail = await adding
    pendingFocus.current = stacked ? 'back' : null
    setOpenedName(detail.name)
  }

  // The deleted row, and stacked the whole detail with its menu, unmount once
  // the skill is gone: show the list now, not the fallback skill's
  // instructions, and hand focus to the neighbouring row.
  const confirmDelete = (name: string) => {
    const index = skills.findIndex((skill) => skill.name === name)
    const neighbour = skills[index + 1] ?? skills[index - 1]
    pendingFocus.current = neighbour ? { row: neighbour.name } : 'list'
    if (openedName === name) setOpenedName(null)
    setDeleteName(null)
    void mutate(() => remove(name))
  }

  const mutate = async (operation: () => Promise<void>) => {
    try {
      await operation()
    } catch (reason) {
      toast.error(String(reason))
    }
  }

  const tryInChat = (name: string) => {
    void navigate({
      to: route.home,
      search: { agentSkill: name },
    })
  }

  const download = async (name: string) => {
    try {
      if (await exportSkill(name)) {
        toast.success(t('common:skillExported'))
      }
    } catch (reason) {
      toast.error(String(reason))
    }
  }

  return (
    <div
      ref={pageRef}
      className={cn(
        'grid h-svh w-full grid-rows-[auto_minmax(0,1fr)]',
        stacked ? 'grid-cols-1' : 'grid-cols-[minmax(260px,360px)_1fr]'
      )}
    >
      {showList && (
        <>
          <HeaderPage>
            <div
              className={cn(
                'flex w-full items-center justify-between',
                !stacked && 'max-w-[332px]'
              )}
            >
              <span className="font-studio text-base font-medium">
                {t('common:skills')}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title={t('common:refresh')}
                  disabled={loading}
                  onClick={() => void load(true)}
                >
                  <IconRefresh className={cn(loading && 'animate-spin')} />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm">
                      {t('common:createNewSkill')}
                      <IconChevronDown />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-max">
                    <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
                      <IconClipboardText />
                      {t('common:writeSkillInstructions')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setUploadOpen(true)}>
                      <IconUpload />
                      {t('common:uploadASkill')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </HeaderPage>

          <div
            ref={listRef}
            tabIndex={-1}
            className="min-h-0 overflow-y-auto p-3 outline-none"
          >
            {error && (
              <div className="mb-3 rounded-md border border-destructive/40 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
            {!loading && skills.length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">
                {t('common:skillsEmpty')}
              </p>
            )}
            <div className="space-y-2">
              {skills.map((skill) => {
                const canTry = canTrySkill(skill)
                return (
                  <div
                    key={skill.name}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg border p-2 transition-colors hover:bg-accent',
                      selected?.name === skill.name && 'bg-accent'
                    )}
                  >
                    <button
                      ref={(element) => {
                        if (element) rowRefs.current.set(skill.name, element)
                        else rowRefs.current.delete(skill.name)
                      }}
                      type="button"
                      className="min-w-0 flex-1 p-1 text-left"
                      onClick={() => openSkill(skill.name)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {skill.name}
                        </span>
                        {skill.error && (
                          <IconAlertTriangle className="size-4 text-destructive" />
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {skill.error || skill.description}
                      </p>
                    </button>
                    <Switch
                      checked={skill.enabled}
                      disabled={Boolean(skill.error)}
                      aria-label={t('common:enableSkill')}
                      onCheckedChange={(enabled) =>
                        void mutate(() => setEnabled(skill.name, enabled))
                      }
                    />
                    <SkillActionsMenu
                      skill={skill}
                      canTry={canTry}
                      onDownload={() => void download(skill.name)}
                      onTry={() => tryInChat(skill.name)}
                      onEdit={() => {
                        void select(skill.name)
                        setEditOpen(true)
                      }}
                      onUninstall={() => setDeleteName(skill.name)}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}

      {detailOpen && selected && (
        <HeaderPage>
          <div className="flex w-full min-w-0 items-center gap-2">
            <Button
              ref={backRef}
              size="icon-sm"
              variant="ghost"
              aria-label={t('common:backToSkills')}
              title={t('common:backToSkills')}
              onClick={closeSkill}
            >
              <IconArrowLeft />
            </Button>
            <span
              className="min-w-0 flex-1 truncate font-studio text-base font-medium"
              title={selected.name}
            >
              {selected.name}
            </span>
            {selected.error && (
              <IconAlertTriangle className="size-4 shrink-0 text-destructive" />
            )}
            <Switch
              checked={selected.enabled}
              disabled={Boolean(selected.error)}
              aria-label={t('common:enableSkill')}
              onCheckedChange={(enabled) =>
                void mutate(() => setEnabled(selected.name, enabled))
              }
            />
            <SkillActionsMenu
              skill={selected}
              canTry={canTrySkill(selected)}
              onDownload={() => void download(selected.name)}
              onTry={() => tryInChat(selected.name)}
              onEdit={() => setEditOpen(true)}
              onUninstall={() => setDeleteName(selected.name)}
            />
          </div>
        </HeaderPage>
      )}

      {showDetail && (
        <div
          className={cn(
            'min-h-0 min-w-0 overflow-y-auto p-3',
            stacked ? 'row-start-2' : 'col-start-2 row-span-2 row-start-1'
          )}
        >
          {!selected ? (
            <p className="text-sm text-muted-foreground">
              {t('common:selectSkill')}
            </p>
          ) : (
            <div className="flex min-h-full flex-col gap-2">
              {selected.unavailableReasons.length > 0 && (
                <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
                  <h2 className="mb-2 font-medium">
                    {t('common:skillUnavailable')}
                  </h2>
                  {selected.unavailableReasons.join('\n')}
                </section>
              )}
              {selected.error && (
                <section className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
                  <h2 className="mb-2 font-medium">{t('common:skillError')}</h2>
                  {selected.error}
                </section>
              )}
              <section className="flex-1 rounded-lg border bg-background p-4 text-sm">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="font-medium">
                    {t('common:skillInstructions')}
                  </h2>
                  {!selected.reserved && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t('common:editSkill')}
                      onClick={() => setEditOpen(true)}
                    >
                      <IconEdit />
                    </Button>
                  )}
                </div>
                <RenderMarkdown
                  content={selected.body}
                  className="is-compact"
                  components={{}}
                  isAnimating={false}
                />
              </section>
            </div>
          )}
        </div>
      )}

      <Dialog
        open={deleteName !== null}
        onOpenChange={(open) => !open && setDeleteName(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('common:deleteSkill')}</DialogTitle>
            <DialogDescription>
              {t('common:deleteSkillDescription', { name: deleteName })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteName(null)}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteName) confirmDelete(deleteName)
              }}
            >
              {t('common:delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AgentSkillCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={(request) => openAdded(addCreated(request))}
      />
      <AgentSkillUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUpload={(path) => openAdded(addImported(path))}
      />
      <AgentSkillEditDialog
        skill={selected}
        open={editOpen}
        onOpenChange={setEditOpen}
        onUpdate={update}
      />
    </div>
  )
}

function canTrySkill(skill: AgentSkill) {
  return (
    skill.enabled &&
    skill.compatible &&
    !skill.error &&
    skill.unavailableReasons.length === 0
  )
}

type SkillActionsMenuProps = {
  skill: AgentSkill
  canTry: boolean
  onDownload: () => void
  onTry: () => void
  onEdit: () => void
  onUninstall: () => void
}

function SkillActionsMenu({
  skill,
  canTry,
  onDownload,
  onTry,
  onEdit,
  onUninstall,
}: SkillActionsMenuProps) {
  const { t } = useTranslation()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('common:skillActions')}
        >
          <IconDots />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onDownload}>
          <IconDownload />
          {t('common:downloadSkill')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canTry} onSelect={onTry}>
          <IconMessage />
          {t('common:tryInChat')}
        </DropdownMenuItem>
        {!skill.reserved && (
          <>
            <DropdownMenuItem onSelect={onEdit}>
              <IconEdit />
              {t('common:editSkill')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onUninstall}>
              <IconTrash />
              {t('common:delete')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
