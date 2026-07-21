import { useState, type ReactNode } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import {
  IconAlertTriangle,
  IconChevronDown,
  IconFolderPlus,
  IconPencilPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react'
import { toast } from 'sonner'
import HeaderPage from '@/containers/HeaderPage'
import { AgentSkillCreateDialog } from '@/containers/AgentSkillCreateDialog'
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { route } from '@/constants/routes'
import { useAgentSkills } from '@/hooks/useAgentSkills'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.skills.index as any)({
  component: SkillsPage,
})

export function SkillsPage() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
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
  } = useAgentSkills()
  const [deleteName, setDeleteName] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const mutate = async (operation: () => Promise<void>) => {
    try {
      await operation()
    } catch (reason) {
      toast.error(String(reason))
    }
  }

  const importFolder = async () => {
    const selectedPath = await serviceHub.dialog().open({
      multiple: false,
      directory: true,
    })
    if (typeof selectedPath === 'string') {
      await addImported(selectedPath)
    }
  }

  return (
    <div className="flex h-svh w-full flex-col">
      <HeaderPage>
        <div className="flex w-full items-center justify-between pr-3">
          <span className="font-studio text-base font-medium">
            {t('common:skills')}
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => void load(true)}
            >
              <IconRefresh className={cn(loading && 'animate-spin')} />
              {t('common:refresh')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm">
                  {t('common:createNewSkill')}
                  <IconChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onSelect={() => void mutate(importFolder)}>
                  <IconFolderPlus />
                  {t('common:fromFolder')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
                  <IconPencilPlus />
                  {t('common:newSkill')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </HeaderPage>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,360px)_1fr]">
        <div className="overflow-y-auto border-r p-3">
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
            {skills.map((skill) => (
              <button
                key={skill.name}
                type="button"
                className={cn(
                  'w-full rounded-lg border p-3 text-left transition-colors hover:bg-accent',
                  selected?.name === skill.name && 'bg-accent'
                )}
                onClick={() => void select(skill.name)}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {skill.name}
                  </span>
                  {skill.reserved && (
                    <StatusBadge>{t('common:bundled')}</StatusBadge>
                  )}
                  {skill.error && (
                    <IconAlertTriangle className="size-4 text-destructive" />
                  )}
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {skill.error || skill.description}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  <StatusBadge>
                    {t(
                      skill.enabled
                        ? 'common:skillEnabled'
                        : 'common:skillDisabled'
                    )}
                  </StatusBadge>
                  {!skill.compatible && (
                    <StatusBadge>{t('common:incompatible')}</StatusBadge>
                  )}
                  {skill.dangerous && (
                    <StatusBadge>{t('common:dangerous')}</StatusBadge>
                  )}
                  {skill.requiresScripts.length > 0 && (
                    <StatusBadge>
                      {t('common:scriptsCount', {
                        count: skill.requiresScripts.length,
                      })}
                    </StatusBadge>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="min-w-0 overflow-y-auto p-6">
          {!selected ? (
            <p className="text-sm text-muted-foreground">
              {t('common:selectSkill')}
            </p>
          ) : (
            <div className="mx-auto max-w-4xl">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-xl font-semibold">{selected.name}</h1>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {selected.description}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Switch
                    checked={selected.enabled}
                    disabled={Boolean(selected.error)}
                    aria-label={t('common:enableSkill')}
                    onCheckedChange={(enabled) =>
                      void mutate(() => setEnabled(selected.name, enabled))
                    }
                  />
                  {!selected.reserved && (
                    <Button
                      size="icon"
                      variant="ghost"
                      title={t('common:delete')}
                      onClick={() => setDeleteName(selected.name)}
                    >
                      <IconTrash className="text-destructive" />
                    </Button>
                  )}
                </div>
              </div>

              {selected.unavailableReasons.length > 0 && (
                <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                  {selected.unavailableReasons.join('\n')}
                </div>
              )}
              {selected.error && (
                <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  {selected.error}
                </div>
              )}
              <div className="mt-6 rounded-lg border bg-muted/30 p-4 text-sm">
                <RenderMarkdown
                  content={selected.body}
                  components={{}}
                  isAnimating={false}
                />
              </div>
            </div>
          )}
        </div>
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
    </div>
  )
}

function StatusBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
      {children}
    </span>
  )
}
