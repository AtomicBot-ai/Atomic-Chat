import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { PanelRight } from 'lucide-react'
import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFolder,
} from '@tabler/icons-react'
import { listAgentWorkspace } from '@/services/agent/tauri'
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

  const rootState = directories['']
  const title = useMemo(() => workspaceName(workingDir), [workingDir])

  const renderEntries = (path: string, depth: number): ReactNode => {
    const state = directories[path]
    if (state?.loading) {
      return (
        <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
      )
    }
    if (state?.error) {
      return (
        <div className="px-3 py-2 text-xs text-destructive" title={state.error}>
          Could not load this directory.
        </div>
      )
    }
    if (state?.entries?.length === 0) {
      return (
        <div className="px-3 py-2 text-xs text-muted-foreground">Empty</div>
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
              'flex h-7 w-full items-center gap-1.5 truncate rounded-sm pr-2 text-left text-xs hover:bg-accent',
              entry.kind === 'unknown' && 'text-muted-foreground'
            )}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            onClick={() => {
              if (isDirectory) toggleDirectory(entry.path)
              else if (entry.kind === 'file') openFile(entry.path)
            }}
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
              <IconFolder className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <IconFile className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{entry.name}</span>
          </button>
          {isExpanded && renderEntries(entry.path, depth + 1)}
        </div>
      )
    })
  }

  return (
    <aside className="flex h-full min-w-0 flex-col border-l bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
        <span
          className="min-w-0 flex-1 truncate px-1 text-xs font-medium"
          title={workingDir}
        >
          {title}
        </span>
        <button
          type="button"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close files sidebar"
          title="Close files sidebar"
          onClick={onClose}
        >
          <PanelRight className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1">
        {!rootState ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            Loading…
          </div>
        ) : (
          renderEntries('', 0)
        )}
      </div>
    </aside>
  )
}
