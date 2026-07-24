import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  IconAlertTriangle,
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
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { route } from '@/constants/routes'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useAgentSkills } from '@/hooks/useAgentSkills'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { AgentSkill } from '@/services/agent/skills'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.skills.index as any)({
  component: SkillsPage,
})

export function SkillsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const setSidebarMode = useAgentMode((state) => state.setSidebarMode)
  const setAgentMode = useAgentMode((state) => state.setAgentMode)
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

  const mutate = async (operation: () => Promise<void>) => {
    try {
      await operation()
    } catch (reason) {
      toast.error(String(reason))
    }
  }

  const tryInChat = (name: string) => {
    setSidebarMode('agent')
    setAgentMode(TEMPORARY_CHAT_ID, true)
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
                  type="button"
                  className="min-w-0 flex-1 p-1 text-left"
                  onClick={() => void select(skill.name)}
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
                if (deleteName) {
                  void mutate(() => remove(deleteName))
                  setDeleteName(null)
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
        onCreate={addCreated}
      />
      <AgentSkillUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUpload={addImported}
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
              {t('common:uninstallSkill')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
