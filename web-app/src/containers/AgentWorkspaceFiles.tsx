import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFolder,
} from '@tabler/icons-react'
import { PanelRight } from 'lucide-react'
import { toast } from 'sonner'
import {
  listAgentWorkspace,
  resolveAgentWorkspacePath,
} from '@/services/agent/tauri'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useWorkspacePreviewStore } from '@/stores/workspace-preview-store'
import type { AgentWorkspaceEntry } from '@/types/agent'
import { cn } from '@/lib/utils'

type AgentWorkspaceFilesProps = {
  workingDir?: string
  refreshKey: number
  onClose: () => void
}

type DirectoryState = {
  entries?: AgentWorkspaceEntry[]
  loading?: boolean
  error?: string
}

function workspaceName(workingDir?: string): string {
  if (!workingDir) return 'Agent workspace'
  return workingDir.split(/[\\/]/).filter(Boolean).at(-1) ?? workingDir
}

export function AgentWorkspaceFiles({
  workingDir,
  refreshKey,
  onClose,
}: AgentWorkspaceFilesProps) {
  const serviceHub = useServiceHub()
  const openFile = useWorkspacePreviewStore((state) => state.openFile)
  const [directories, setDirectories] = useState<
    Record<string, DirectoryState>
  >({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))

  const loadDirectory = useCallback(
    async (path: string) => {
      setDirectories((state) => ({
        ...state,
        [path]: { ...state[path], loading: true, error: undefined },
      }))
      try {
        const entries = await listAgentWorkspace({
          workingDir,
          path: path || undefined,
        })
        setDirectories((state) => ({
          ...state,
          [path]: { entries, loading: false },
        }))
      } catch (error) {
        setDirectories((state) => ({
          ...state,
          [path]: { loading: false, error: String(error) },
        }))
      }
    },
    [workingDir]
  )

  useEffect(() => {
    setDirectories({})
    setExpanded(new Set(['']))
    void loadDirectory('')
  }, [loadDirectory, refreshKey])

  const toggleDirectory = useCallback(
    (path: string) => {
      setExpanded((current) => {
        const next = new Set(current)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
          void loadDirectory(path)
        }
        return next
      })
    },
    [loadDirectory]
  )

  const revealEntry = useCallback(
    async (path: string) => {
      try {
        const absolutePath = await resolveAgentWorkspacePath({
          workingDir,
          path,
        })
        await serviceHub.opener().revealItemInDir(absolutePath)
      } catch (error) {
        console.error('Failed to reveal Agent workspace entry:', error)
        toast.error('Could not show this item on disk.')
      }
    },
    [serviceHub, workingDir]
  )

  const rootState = directories['']
  const title = useMemo(() => workspaceName(workingDir), [workingDir])
  const rootExpanded = expanded.has('')

  const renderEntries = (path: string, depth: number): ReactNode => {
    const state = directories[path]
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
    if (state?.entries?.length === 0) {
      return (
        <div
          className="py-2 pr-2 text-xs text-sidebar-foreground/70"
          style={{ paddingLeft: `${54 + depth * 16}px` }}
        >
          Empty
        </div>
      )
    }

    return state?.entries?.map((entry) => {
      const isDirectory = entry.kind === 'directory'
      const isExpanded = isDirectory && expanded.has(entry.path)
      return (
        <div key={entry.path}>
          <button
            type="button"
            className={cn(
              'flex h-8 w-full items-center gap-2 overflow-hidden rounded-md pr-2 text-left text-sm text-sidebar-foreground outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-foreground/8 hover:text-sidebar-accent-foreground focus-visible:ring-2',
              entry.kind === 'unknown' && 'text-sidebar-foreground/70'
            )}
            style={{ paddingLeft: `${8 + depth * 16}px` }}
            onClick={(event) => {
              if (event.detail > 1) return
              if (isDirectory) toggleDirectory(entry.path)
              else if (entry.kind === 'file') openFile(entry.path)
            }}
            onDoubleClick={() => void revealEntry(entry.path)}
            title={entry.path}
          >
            {isDirectory ? (
              isExpanded ? (
                <IconChevronDown className="size-3.5 shrink-0" />
              ) : (
                <IconChevronRight className="size-3.5 shrink-0" />
              )
            ) : (
              <span className="size-3.5 shrink-0" />
            )}
            {isDirectory ? (
              <IconFolder className="size-4 shrink-0 text-sidebar-foreground/70" />
            ) : (
              <IconFile className="size-4 shrink-0 text-sidebar-foreground/70" />
            )}
            <span className="truncate">{entry.name}</span>
          </button>
          {isExpanded && renderEntries(entry.path, depth + 1)}
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
              !IS_WINDOWS && 'justify-end'
            )}
          >
            <button
              type="button"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-foreground/8 hover:text-sidebar-foreground focus-visible:ring-2"
              aria-label="Close files sidebar"
              title="Close files sidebar"
              onClick={onClose}
            >
              <PanelRight className="size-4" />
            </button>
          </div>
          <button
            type="button"
            className="flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-2 text-left text-sm font-medium text-sidebar-foreground outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-foreground/8 hover:text-sidebar-accent-foreground focus-visible:ring-2"
            aria-label={`${rootExpanded ? 'Collapse' : 'Expand'} ${title}`}
            title={workingDir ?? title}
            onClick={() => toggleDirectory('')}
          >
            {rootExpanded ? (
              <IconChevronDown className="size-3.5 shrink-0" />
            ) : (
              <IconChevronRight className="size-3.5 shrink-0" />
            )}
            <IconFolder className="size-4 shrink-0 text-sidebar-foreground/70" />
            <span className="truncate">{title}</span>
          </button>
          {rootExpanded &&
            (!rootState ? (
              <div className="py-2 pl-10 text-xs text-sidebar-foreground/70">
                Loading…
              </div>
            ) : (
              renderEntries('', 1)
            ))}
        </div>
      </aside>
    </div>
  )
}
