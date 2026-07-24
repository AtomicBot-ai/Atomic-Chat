import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconDots,
  IconEye,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react'
import { PanelRight } from 'lucide-react'
import { toast } from 'sonner'
import {
  listAgentWorkspace,
  resolveAgentWorkspacePath,
} from '@/services/agent/tauri'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useWorkspacePreviewStore } from '@/stores/workspace-preview-store'
import type { AgentWorkspaceEntry } from '@/types/agent'
import type { AgentWorkspace, AgentWorkspaceRoot } from '@/hooks/useAgentMode'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

type AgentWorkspaceFilesProps = {
  threadId: string
  workspace: AgentWorkspace
  refreshKey: number
  isGenerating: boolean
  onClose: () => void
  onAddExternal: () => void
}

type DirectoryState = {
  entries?: AgentWorkspaceEntry[]
  loading?: boolean
  error?: string
}

type WorkspaceSectionProps = {
  title: string
  roots: AgentWorkspaceRoot[]
  expanded: Set<string>
  directories: Record<string, DirectoryState>
  entryKey: (rootId: string, path: string) => string
  onToggle: (root: AgentWorkspaceRoot, path: string) => Promise<void>
  renderEntries: (
    root: AgentWorkspaceRoot,
    path: string,
    depth: number
  ) => ReactNode
  permissionLabels?: { canEdit: string; viewOnly: string }
  rootActions?: {
    disabled: boolean
    setPermission: (root: AgentWorkspaceRoot, canEdit: boolean) => void
    remove: (root: AgentWorkspaceRoot) => void
    canEditLabel: string
    viewOnlyLabel: string
    removeLabel: string
    menuLabel: string
  }
  action?: ReactNode
}

function WorkspaceSection({
  title,
  roots,
  expanded,
  directories,
  entryKey,
  onToggle,
  renderEntries,
  permissionLabels,
  rootActions,
  action,
}: WorkspaceSectionProps) {
  return (
    <section className="mt-2">
      <div className="flex h-8 items-center justify-between pl-2 text-xs font-medium uppercase tracking-wide text-sidebar-foreground/60">
        <span>{title}</span>
        {action}
      </div>
      {roots.map((root) => {
        const key = entryKey(root.rootId, '')
        const rootExpanded = expanded.has(key)
        const rootState = directories[key]
        return (
          <div key={root.rootId}>
            <div className="flex min-w-0 items-center">
              <button
                type="button"
                className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 overflow-hidden rounded-md px-2 text-left text-sm font-medium text-sidebar-foreground outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-foreground/8 hover:text-sidebar-accent-foreground focus-visible:ring-2"
                aria-label={`${rootExpanded ? 'Collapse' : 'Expand'} ${root.name}`}
                title={root.path}
                onClick={() => void onToggle(root, '')}
              >
                {rootExpanded ? (
                  <IconFolderOpen className="size-4 shrink-0 text-sidebar-foreground/70" />
                ) : (
                  <IconFolder className="size-4 shrink-0 text-sidebar-foreground/70" />
                )}
                <span className="min-w-0 flex-1 truncate">{root.name}</span>
                {permissionLabels && (
                  <span className="shrink-0 px-1.5 text-[10px] font-semibold text-sidebar-foreground/50">
                    {root.canEdit
                      ? permissionLabels.canEdit
                      : permissionLabels.viewOnly}
                  </span>
                )}
              </button>
              {rootActions && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 outline-none ring-sidebar-ring hover:bg-sidebar-foreground/8 focus-visible:ring-2"
                      aria-label={rootActions.menuLabel}
                      title={rootActions.menuLabel}
                      disabled={rootActions.disabled}
                    >
                      <IconDots className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={root.canEdit}
                      onSelect={() => rootActions.setPermission(root, true)}
                    >
                      <IconPencil />
                      {rootActions.canEditLabel}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!root.canEdit}
                      onSelect={() => rootActions.setPermission(root, false)}
                    >
                      <IconEye />
                      {rootActions.viewOnlyLabel}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => rootActions.remove(root)}
                    >
                      <IconTrash />
                      {rootActions.removeLabel}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            {rootExpanded &&
              (!rootState ? (
                <div className="py-2 pl-10 text-xs text-sidebar-foreground/70">
                  Loading…
                </div>
              ) : (
                renderEntries(root, '', 1)
              ))}
          </div>
        )
      })}
    </section>
  )
}

export function AgentWorkspaceFiles({
  threadId,
  workspace,
  refreshKey,
  isGenerating,
  onClose,
  onAddExternal,
}: AgentWorkspaceFilesProps) {
  const { t } = useTranslation('chat')
  const serviceHub = useServiceHub()
  const openFile = useWorkspacePreviewStore((state) => state.openFile)
  const setExternalRootPermission = useAgentMode(
    (state) => state.setExternalRootPermission
  )
  const removeExternalRoot = useAgentMode((state) => state.removeExternalRoot)
  const [directories, setDirectories] = useState<
    Record<string, DirectoryState>
  >({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [isRefreshing, setIsRefreshing] = useState(false)
  const roots = useMemo(
    () =>
      [workspace.primaryRoot, ...workspace.externalRoots].filter(
        (root): root is AgentWorkspaceRoot => Boolean(root)
      ),
    [workspace.externalRoots, workspace.primaryRoot]
  )

  const entryKey = useCallback(
    (rootId: string, path: string) => `${rootId}:${path}`,
    []
  )

  const loadDirectory = useCallback(
    async (
      root: AgentWorkspaceRoot,
      path: string
    ): Promise<AgentWorkspaceEntry[] | undefined> => {
      const key = entryKey(root.rootId, path)
      setDirectories((state) => ({
        ...state,
        [key]: { ...state[key], loading: true, error: undefined },
      }))
      try {
        const entries = await listAgentWorkspace({
          rootId: root.rootId,
          rootPath: root.path,
          relativePath: path || undefined,
        })
        setDirectories((state) => ({
          ...state,
          [key]: { entries, loading: false },
        }))
        return entries
      } catch (error) {
        setDirectories((state) => ({
          ...state,
          [key]: { loading: false, error: String(error) },
        }))
        return undefined
      }
    },
    [entryKey]
  )

  useEffect(() => {
    let active = true
    setDirectories({})
    setExpanded(new Set())
    void Promise.all(
      roots.map(async (root) => {
        const entries = await loadDirectory(root, '')
        return { root, entries }
      })
    ).then((results) => {
      if (!active) return
      setExpanded(
        new Set(
          results
            .filter(({ entries }) => Boolean(entries?.length))
            .map(({ root }) => entryKey(root.rootId, ''))
        )
      )
    })
    return () => {
      active = false
    }
  }, [entryKey, loadDirectory, refreshKey, roots])

  const toggleDirectory = useCallback(
    async (root: AgentWorkspaceRoot, path: string) => {
      const key = entryKey(root.rootId, path)
      if (expanded.has(key)) {
        setExpanded((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
        return
      }

      const cached = directories[key]
      if (cached?.loading) return
      const entries = cached?.entries ?? (await loadDirectory(root, path))
      if (entries?.length === 0) return

      setExpanded((current) => new Set(current).add(key))
    },
    [directories, entryKey, expanded, loadDirectory]
  )

  const refreshDirectories = useCallback(async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      await Promise.all(
        roots.flatMap((root) => {
          const prefix = `${root.rootId}:`
          const loadedPaths = Object.keys(directories)
            .filter((key) => key.startsWith(prefix))
            .map((key) => key.slice(prefix.length))
          return [...new Set(['', ...loadedPaths])].map((path) =>
            loadDirectory(root, path)
          )
        })
      )
    } finally {
      setIsRefreshing(false)
    }
  }, [directories, isRefreshing, loadDirectory, roots])

  const revealEntry = useCallback(
    async (root: AgentWorkspaceRoot, path: string) => {
      try {
        const absolutePath = await resolveAgentWorkspacePath({
          rootId: root.rootId,
          rootPath: root.path,
          relativePath: path,
        })
        await serviceHub.opener().revealItemInDir(absolutePath)
      } catch (error) {
        console.error('Failed to reveal Agent workspace entry:', error)
        toast.error('Could not show this item on disk.')
      }
    },
    [serviceHub]
  )

  const removeRoot = useCallback(
    (root: AgentWorkspaceRoot) => {
      const previewState = useWorkspacePreviewStore.getState()
      previewState.tabs
        .filter((tab) => tab.kind === 'file' && tab.rootId === root.rootId)
        .forEach((tab) => previewState.closeTab(tab.id))
      removeExternalRoot(threadId, root.rootId)
    },
    [removeExternalRoot, threadId]
  )

  const renderEntries = (
    root: AgentWorkspaceRoot,
    path: string,
    depth: number
  ): ReactNode => {
    const state = directories[entryKey(root.rootId, path)]
    if (state?.loading) {
      return (
        <div
          className="py-2 pr-2 text-xs text-sidebar-foreground/70"
          style={{ paddingLeft: `${54 + depth * 16}px` }}
        >
          Loading…
        </div>
      )
    }
    if (state?.error) {
      return (
        <div
          className="py-2 pr-3 text-xs text-destructive"
          style={{ paddingLeft: `${54 + depth * 16}px` }}
          title={state.error}
        >
          Could not load this directory.
        </div>
      )
    }
    if (state?.entries?.length === 0) return null

    return state?.entries?.map((entry) => {
      const isDirectory = entry.kind === 'directory'
      const isExpanded =
        isDirectory && expanded.has(entryKey(root.rootId, entry.path))
      return (
        <div key={entry.path}>
          <button
            type="button"
            className={cn(
              'flex h-8 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-md pr-2 text-left text-sm text-sidebar-foreground outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-foreground/8 hover:text-sidebar-accent-foreground focus-visible:ring-2',
              entry.kind === 'unknown' && 'text-sidebar-foreground/70'
            )}
            style={{ paddingLeft: `${8 + depth * 16}px` }}
            onClick={(event) => {
              if (event.detail > 1) return
              if (isDirectory) void toggleDirectory(root, entry.path)
              else if (entry.kind === 'file')
                openFile({
                  rootId: root.rootId,
                  rootPath: root.path,
                  relativePath: entry.path,
                })
            }}
            onDoubleClick={() => void revealEntry(root, entry.path)}
            title={entry.path}
          >
            {isDirectory ? (
              isExpanded ? (
                <IconFolderOpen className="size-4 shrink-0 text-sidebar-foreground/70" />
              ) : (
                <IconFolder className="size-4 shrink-0 text-sidebar-foreground/70" />
              )
            ) : (
              <IconFile className="size-4 shrink-0 text-sidebar-foreground/70" />
            )}
            <span className="truncate">{entry.name}</span>
          </button>
          {isExpanded && renderEntries(root, entry.path, depth + 1)}
        </div>
      )
    })
  }

  return (
    <div className="h-full p-2 pl-0">
      <aside className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-sidebar-border bg-clip-padding bg-linear-to-b from-sidebar to-background text-sidebar-foreground shadow dark:from-sidebar/70">
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <div
            className={cn(
              'flex h-8 items-center',
              IS_WINDOWS ? 'justify-start' : 'justify-between'
            )}
          >
            <button
              type="button"
              className={cn(
                'flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-foreground/8 hover:text-sidebar-foreground focus-visible:ring-2 disabled:cursor-default disabled:opacity-50',
                IS_WINDOWS && 'order-2'
              )}
              aria-label={t('common:refresh')}
              title={t('common:refresh')}
              disabled={isRefreshing}
              onClick={() => void refreshDirectories()}
            >
              <IconRefresh
                className={cn('size-4', isRefreshing && 'animate-spin')}
              />
            </button>
            <button
              type="button"
              className={cn(
                'flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-foreground/8 hover:text-sidebar-foreground focus-visible:ring-2',
                IS_WINDOWS && 'order-1'
              )}
              aria-label="Close files sidebar"
              title="Close files sidebar"
              onClick={onClose}
            >
              <PanelRight className="size-4" />
            </button>
          </div>
          {workspace.primaryRoot && (
            <WorkspaceSection
              title={t('agentWorkspace.projectFiles')}
              roots={[workspace.primaryRoot]}
              expanded={expanded}
              directories={directories}
              entryKey={entryKey}
              onToggle={toggleDirectory}
              renderEntries={renderEntries}
            />
          )}
          <WorkspaceSection
            title={t('agentWorkspace.external')}
            roots={workspace.externalRoots}
            expanded={expanded}
            directories={directories}
            entryKey={entryKey}
            onToggle={toggleDirectory}
            renderEntries={renderEntries}
            permissionLabels={{
              canEdit: t('agentWorkspace.canEdit'),
              viewOnly: t('agentWorkspace.viewOnly'),
            }}
            rootActions={{
              disabled: isGenerating,
              setPermission: (root, canEdit) =>
                setExternalRootPermission(threadId, root.rootId, canEdit),
              remove: removeRoot,
              canEditLabel: t('agentWorkspace.allowEditing'),
              viewOnlyLabel: t('agentWorkspace.makeViewOnly'),
              removeLabel: t('agentWorkspace.removeFolder'),
              menuLabel: t('agentWorkspace.folderOptions'),
            }}
            action={
              <button
                type="button"
                className="flex size-8 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-foreground/8"
                onClick={onAddExternal}
                aria-label={t('agentWorkspace.addFolder')}
                title={t('agentWorkspace.addFolder')}
              >
                <IconPlus className="size-4" />
              </button>
            }
          />
        </div>
      </aside>
    </div>
  )
}
