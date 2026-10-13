import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
  IconClipboardText,
  IconDots,
  IconDownload,
  IconEdit,
  IconFolder,
  IconMessage,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react'
import { toast } from 'sonner'
import HeaderPage from '@/containers/HeaderPage'
import { AgentSkillCreateDialog } from '@/containers/AgentSkillCreateDialog'
import { AgentSkillEditDialog } from '@/containers/AgentSkillEditDialog'
import { AgentSkillMoveDialog } from '@/containers/AgentSkillMoveDialog'
import { AgentSkillUploadDialog } from '@/containers/AgentSkillUploadDialog'
import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { SkillReviewDialog } from '@/containers/SkillReviewDialog'
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
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { route } from '@/constants/routes'
import { useAgentSkills } from '@/hooks/useAgentSkills'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  SKILL_GROUP_BY,
  SKILL_SORT_BY,
  filterSkills,
  formatSkillSize,
  groupSkills,
  knownCategories,
  knownFolders,
  readSkillViewPrefs,
  skillCategory,
  skillCreator,
  skillSource,
  sortSkills,
  writeSkillViewPrefs,
  type SkillGroupBy,
  type SkillSortBy,
  type SkillViewPrefs,
} from '@/lib/skill-organization'
import { cn } from '@/lib/utils'
import {
  getAgentSkill,
  type AgentSkill,
  type AgentSkillDetail,
} from '@/services/agent/skills'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.skills.index as any)({
  component: SkillsPage,
})

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
    approve,
    addCreated,
    addImported,
    remove,
    update,
    move,
    exportSkill,
  } = useAgentSkills()
  const [deleteTarget, setDeleteTarget] = useState<AgentSkill | null>(null)
  const [moveTarget, setMoveTarget] = useState<AgentSkill | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  // Task 28 (D36): every skill - bundled, from Anthropic, written here or
  // uploaded - is reviewed (Allow / Preview / Cancel) before it is switched on.
  const [reviewing, setReviewing] = useState<AgentSkillDetail | null>(null)
  // How the list is arranged: kept across visits (localStorage).
  const [query, setQuery] = useState('')
  const [prefs, setPrefs] = useState<SkillViewPrefs>(() => readSkillViewPrefs())
  useEffect(() => writeSkillViewPrefs(prefs), [prefs])
  const groups = useMemo(
    () =>
      groupSkills(
        sortSkills(filterSkills(skills, query), prefs.sortBy),
        prefs.groupBy
      ),
    [skills, query, prefs.sortBy, prefs.groupBy]
  )
  const categories = useMemo(() => knownCategories(skills), [skills])
  const folders = useMemo(() => knownFolders(skills), [skills])
  const collapsed = new Set(prefs.collapsed[prefs.groupBy] ?? [])
  const matches = groups.reduce(
    (count, group) => count + group.skills.length,
    0
  )

  const toggleGroup = (key: string) => {
    setPrefs((current) => {
      const keys = new Set(current.collapsed[current.groupBy] ?? [])
      if (keys.has(key)) keys.delete(key)
      else keys.add(key)
      return {
        ...current,
        collapsed: { ...current.collapsed, [current.groupBy]: [...keys] },
      }
    })
  }

  const openReview = async (name: string) => {
    try {
      setReviewing(await getAgentSkill(name))
    } catch (reason) {
      toast.error(String(reason))
    }
  }

  const reviewIfNeeded = (detail: AgentSkillDetail) => {
    if (detail.needsReview) setReviewing(detail)
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
    <div className="grid h-svh w-full grid-cols-[minmax(260px,360px)_1fr] grid-rows-[auto_minmax(0,1fr)]">
      <HeaderPage>
        <div className="flex w-full max-w-[332px] items-center justify-between">
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

      <div className="min-h-0 overflow-y-auto p-3">
        <div className="mb-3 space-y-2">
          <div className="relative">
            <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              aria-label={t('common:skillSearchPlaceholder')}
              placeholder={t('common:skillSearchPlaceholder')}
              className="h-8 pl-8"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
              {t('common:skillGroupBy')}
              <select
                value={prefs.groupBy}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                onChange={(event) =>
                  setPrefs((current) => ({
                    ...current,
                    groupBy: event.target.value as SkillGroupBy,
                  }))
                }
              >
                {SKILL_GROUP_BY.map((option) => (
                  <option key={option} value={option}>
                    {t(GROUP_LABELS[option])}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
              {t('common:skillSortBy')}
              <select
                value={prefs.sortBy}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                onChange={(event) =>
                  setPrefs((current) => ({
                    ...current,
                    sortBy: event.target.value as SkillSortBy,
                  }))
                }
              >
                {SKILL_SORT_BY.map((option) => (
                  <option key={option} value={option}>
                    {t(SORT_LABELS[option])}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
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
        {skills.length > 0 && matches === 0 && (
          <p className="p-3 text-sm text-muted-foreground">
            {t('common:skillNoMatches')}
          </p>
        )}
        <div className="space-y-3">
          {groups.map((group) => {
            if (group.skills.length === 0) return null
            const grouped = prefs.groupBy !== 'none'
            const isCollapsed = grouped && collapsed.has(group.key)
            const heading = groupHeading(prefs.groupBy, group.label, t)
            return (
              <section
                key={group.key}
                aria-label={grouped ? heading : undefined}
              >
                {grouped && (
                  <button
                    type="button"
                    className="mb-1 flex w-full items-center gap-1 rounded px-1 py-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleGroup(group.key)}
                  >
                    {isCollapsed ? (
                      <IconChevronRight className="size-3.5" />
                    ) : (
                      <IconChevronDown className="size-3.5" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{heading}</span>
                    <span className="tabular-nums">{group.skills.length}</span>
                  </button>
                )}
                {!isCollapsed && (
                  <div className="space-y-2">
                    {group.skills.map((skill) => (
                      <SkillRow
                        key={skill.path ?? skill.name}
                        skill={skill}
                        selected={
                          selected?.name === skill.name &&
                          (selected.path ?? '') === (skill.path ?? '')
                        }
                        onSelect={() => void select(skill.name)}
                        onToggle={(enabled) => {
                          if (enabled && skill.needsReview) {
                            void openReview(skill.name)
                            return
                          }
                          void mutate(() => setEnabled(skill.name, enabled))
                        }}
                        onDownload={() => void download(skill.name)}
                        onTry={() => tryInChat(skill.name)}
                        onEdit={() => {
                          void select(skill.name)
                          setEditOpen(true)
                        }}
                        onMove={() => setMoveTarget(skill)}
                        onUninstall={() => setDeleteTarget(skill)}
                      />
                    ))}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      </div>

      <div className="col-start-2 row-span-2 row-start-1 min-h-0 min-w-0 overflow-y-auto p-3">
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
            <SkillAbout skill={selected} />
            <section className="flex-1 rounded-lg border bg-background p-4 text-sm">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-medium">{t('common:skillInstructions')}</h2>
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
                components={{}}
                isAnimating={false}
              />
            </section>
          </div>
        )}
      </div>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('common:deleteSkill')}</DialogTitle>
            <DialogDescription>
              {t('common:deleteSkillDescription', { name: deleteTarget?.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget) {
                  const { name, path } = deleteTarget
                  void mutate(() => (path ? remove(name, path) : remove(name)))
                  setDeleteTarget(null)
                }
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
        categories={categories}
        onCreate={async (request) => reviewIfNeeded(await addCreated(request))}
      />
      <AgentSkillUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUpload={async (path) => reviewIfNeeded(await addImported(path))}
      />
      {reviewing && (
        <SkillReviewDialog
          open
          skill={reviewing}
          scripts={reviewing.files}
          onAllow={() => {
            const name = reviewing.name
            setReviewing(null)
            void mutate(() => approve(name))
          }}
          onCancel={() => setReviewing(null)}
        />
      )}
      <AgentSkillEditDialog
        skill={selected}
        open={editOpen}
        onOpenChange={setEditOpen}
        onUpdate={update}
        categories={categories}
      />
      <AgentSkillMoveDialog
        skill={moveTarget}
        folders={folders}
        onOpenChange={(open) => !open && setMoveTarget(null)}
        onMove={async (category) => {
          if (moveTarget) await move(moveTarget.name, category)
        }}
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

const GROUP_LABELS: Record<SkillGroupBy, string> = {
  none: 'common:skillGroupNone',
  creator: 'common:skillGroupCreator',
  category: 'common:skillGroupCategory',
  source: 'common:skillGroupSource',
  folder: 'common:skillGroupFolder',
}

const SORT_LABELS: Record<SkillSortBy, string> = {
  'name-asc': 'common:skillSortNameAsc',
  'name-desc': 'common:skillSortNameDesc',
  'size-desc': 'common:skillSortSizeDesc',
  'size-asc': 'common:skillSortSizeAsc',
  'creator': 'common:skillSortCreator',
  'category': 'common:skillSortCategory',
  'recent': 'common:skillSortRecent',
}

type Translate = (key: string, options?: Record<string, unknown>) => string

function groupHeading(groupBy: SkillGroupBy, label: string, t: Translate) {
  if (groupBy === 'source') {
    return label === 'bundled'
      ? t('common:skillSourceBundled')
      : t('common:skillSourceUser')
  }
  if (groupBy === 'folder' && label === '') return t('common:skillTopLevel')
  return label
}

type SkillRowProps = {
  skill: AgentSkill
  selected: boolean
  onSelect: () => void
  onToggle: (enabled: boolean) => void
  onDownload: () => void
  onTry: () => void
  onEdit: () => void
  onMove: () => void
  onUninstall: () => void
}

function SkillRow({
  skill,
  selected,
  onSelect,
  onToggle,
  onDownload,
  onTry,
  onEdit,
  onMove,
  onUninstall,
}: SkillRowProps) {
  const { t } = useTranslation()
  const details =
    skill.creator === undefined && skill.category === undefined
      ? []
      : [
          skillCreator(skill),
          skillCategory(skill),
          formatSkillSize(skill.sizeBytes),
        ].filter(Boolean)
  return (
    <div
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded-lg border p-2 transition-colors hover:bg-accent',
        selected && 'bg-accent'
      )}
    >
      <button
        type="button"
        data-no-hover-glow
        className="min-w-0 flex-1 rounded-md p-1 text-left outline-none"
        onClick={onSelect}
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
        {details.length > 0 && (
          <p className="mt-1 truncate text-[11px] text-muted-foreground/80">
            {details.join(' · ')}
          </p>
        )}
      </button>
      <Switch
        checked={skill.enabled}
        disabled={Boolean(skill.error)}
        aria-label={t('common:enableSkill')}
        onCheckedChange={onToggle}
      />
      <SkillActionsMenu
        skill={skill}
        canTry={canTrySkill(skill)}
        onDownload={onDownload}
        onTry={onTry}
        onEdit={onEdit}
        onMove={onMove}
        onUninstall={onUninstall}
      />
    </div>
  )
}

/** Who made the skill, how it is filed, where it lives and how big it is. */
function SkillAbout({ skill }: { skill: AgentSkill }) {
  const { t } = useTranslation()
  if (skill.creator === undefined && skill.category === undefined) return null
  const rows: [string, string][] = [
    [t('common:skillCreator'), skillCreator(skill)],
    [t('common:skillCategory'), skillCategory(skill)],
  ]
  if (skill.tags && skill.tags.length > 0) {
    rows.push([t('common:skillTags'), skill.tags.join(', ')])
  }
  rows.push(
    [
      t('common:skillSource'),
      skillSource(skill) === 'bundled'
        ? t('common:skillSourceBundled')
        : t('common:skillSourceUser'),
    ],
    [t('common:skillLocation'), skill.path ?? skill.name],
    [
      t('common:skillSize'),
      t('common:skillSizeValue', {
        size: formatSkillSize(skill.sizeBytes ?? 0),
        count: skill.fileCount ?? 0,
      }),
    ]
  )
  return (
    <section
      className="rounded-lg border bg-background p-4 text-sm"
      aria-label={t('common:skillAbout')}
    >
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

type SkillActionsMenuProps = {
  skill: AgentSkill
  canTry: boolean
  onDownload: () => void
  onTry: () => void
  onEdit: () => void
  onMove: () => void
  onUninstall: () => void
}

function SkillActionsMenu({
  skill,
  canTry,
  onDownload,
  onTry,
  onEdit,
  onMove,
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
        {!skill.error && skill.path !== undefined && (
          <DropdownMenuItem onSelect={onMove}>
            <IconFolder />
            {t('common:moveSkillToFolder')}
          </DropdownMenuItem>
        )}
        {!skill.reserved && (
          <>
            <DropdownMenuItem onSelect={onEdit}>
              <IconEdit />
              {t('common:editSkill')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onUninstall}>
              <IconTrash />
              {t('common:uninstallSkill')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
