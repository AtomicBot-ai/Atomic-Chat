import { useEffect, useMemo, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  IconCode,
  IconFile,
  IconFileOff,
  IconLoader2,
  IconX,
} from '@tabler/icons-react'
import { useArtifactStore } from '@/stores/artifact-store'
import {
  useWorkspacePreviewStore,
  type WorkspaceFilePreviewTab,
} from '@/stores/workspace-preview-store'
import {
  readAgentWorkspaceText,
  statAgentWorkspaceFile,
} from '@/services/agent/tauri'
import { classifyWorkspacePreview } from '@/lib/workspace-preview-kind'
import { cn } from '@/lib/utils'

type AgentWorkspacePreviewProps = {
  workingDir?: string
}

function FilePreview({
  tab,
  workingDir,
}: {
  tab: WorkspaceFilePreviewTab
  workingDir?: string
}) {
  const kind = useMemo(() => classifyWorkspacePreview(tab.path), [tab.path])
  const [assetUrl, setAssetUrl] = useState<string>()
  const [text, setText] = useState<string>()
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    setAssetUrl(undefined)
    setText(undefined)
    setTruncated(false)
    setError(undefined)

    const load = async () => {
      try {
        const file = await statAgentWorkspaceFile({
          workingDir,
          path: tab.path,
        })
        if (cancelled) return
        if (kind === 'image' || kind === 'pdf') {
          setAssetUrl(convertFileSrc(file.absolutePath))
          return
        }
        if (kind === 'text') {
          const result = await readAgentWorkspaceText({
            workingDir,
            path: tab.path,
          })
          if (!cancelled) {
            setText(result.content)
            setTruncated(result.truncated)
          }
        }
      } catch (loadError) {
        if (!cancelled) setError(String(loadError))
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [kind, tab.path, workingDir])

  if (kind === 'unsupported') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <IconFileOff className="size-8" />
        <p className="text-sm">Preview is not available for this file type.</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-destructive">
        Could not preview this file.
      </div>
    )
  }

  if ((kind === 'image' || kind === 'pdf') && assetUrl) {
    if (kind === 'image') {
      return (
        <div className="flex h-full items-center justify-center overflow-auto bg-muted/20 p-6">
          <img
            src={assetUrl}
            alt={tab.name}
            className="max-h-full max-w-full rounded-md object-contain shadow-sm"
          />
        </div>
      )
    }
    return (
      <iframe
        src={assetUrl}
        title={tab.name}
        className="h-full w-full border-0 bg-white"
      />
    )
  }

  if (kind === 'text' && text !== undefined) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {truncated && (
          <div className="shrink-0 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
            Preview truncated at 512 KB.
          </div>
        )}
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-muted/10 p-5 font-mono text-xs leading-relaxed">
          {text}
        </pre>
      </div>
    )
  }

  return (
    <div className="flex h-full items-center justify-center">
      <IconLoader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  )
}

export function AgentWorkspacePreview({
  workingDir,
}: AgentWorkspacePreviewProps) {
  const tabs = useWorkspacePreviewStore((state) => state.tabs)
  const activeTabId = useWorkspacePreviewStore((state) => state.activeTabId)
  const closeTab = useWorkspacePreviewStore((state) => state.closeTab)
  const artifact = useArtifactStore()
  const activeTab = tabs.find((tab) => tab.id === activeTabId)

  const close = (id: string) => {
    closeTab(id)
    if (id === 'artifact') artifact.close()
  }

  return (
    <section className="flex h-full min-w-0 flex-col border-l bg-background">
      <div className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b bg-muted/20 px-2">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              'flex h-7 min-w-28 max-w-56 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors',
              tab.id === activeTabId
                ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
                : 'hover:bg-background/60 hover:text-foreground'
            )}
            title={tab.name}
          >
            {tab.kind === 'file' ? (
              <IconFile className="size-3.5 shrink-0" />
            ) : (
              <IconCode className="size-3.5 shrink-0" />
            )}
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left font-medium"
              onClick={() =>
                useWorkspacePreviewStore.setState({ activeTabId: tab.id })
              }
            >
              {tab.name}
            </button>
            <button
              type="button"
              className="flex size-5 shrink-0 items-center justify-center rounded opacity-60 hover:bg-accent hover:opacity-100"
              aria-label={`Close ${tab.name}`}
              onClick={() => close(tab.id)}
            >
              <IconX className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {activeTab?.kind === 'file' && (
          <FilePreview tab={activeTab} workingDir={workingDir} />
        )}
        {activeTab?.kind === 'artifact' && (
          <iframe
            srcDoc={artifact.code}
            title={artifact.title}
            sandbox="allow-scripts"
            className="h-full w-full border-0 bg-white"
          />
        )}
      </div>
    </section>
  )
}
