import { useEffect, useMemo, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  IconCode,
  IconFile,
  IconFileOff,
  IconLoader2,
  IconX,
} from '@tabler/icons-react'
import { AnimatePresence, motion } from 'motion/react'
import { useArtifactStore } from '@/stores/artifact-store'
import { useTranslation } from '@/i18n/react-i18next-compat'
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
import { HtmlArtifact } from './HtmlArtifact'

type AgentWorkspacePreviewProps = {
  isGenerating?: boolean
}

function FilePreview({ tab }: { tab: WorkspaceFilePreviewTab }) {
  const kind = useMemo(
    () => classifyWorkspacePreview(tab.relativePath),
    [tab.relativePath]
  )
  const isHtml = tab.relativePath.toLowerCase().endsWith('.html')
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
          rootId: tab.rootId,
          rootPath: tab.rootPath,
          relativePath: tab.relativePath,
        })
        if (cancelled) return
        if (kind === 'image' || kind === 'pdf') {
          setAssetUrl(convertFileSrc(file.absolutePath))
          return
        }
        if (kind === 'text') {
          const result = await readAgentWorkspaceText({
            rootId: tab.rootId,
            rootPath: tab.rootPath,
            relativePath: tab.relativePath,
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
  }, [kind, tab.relativePath, tab.rootId, tab.rootPath])

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
    if (isHtml) {
      return <HtmlArtifact code={text} fill showActions={false} />
    }

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
  isGenerating = false,
}: AgentWorkspacePreviewProps) {
  const { t } = useTranslation('chat')
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
    <div className="h-full p-2 pl-0">
      <section className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-sidebar-border bg-clip-padding bg-linear-to-b from-sidebar to-background text-sidebar-foreground shadow dark:from-sidebar/70">
        <div className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-sidebar-border bg-muted/20 px-2">
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
                className="min-w-0 flex-1 cursor-pointer truncate text-left font-medium"
                onClick={() =>
                  useWorkspacePreviewStore.setState({ activeTabId: tab.id })
                }
              >
                {tab.name}
              </button>
              <button
                type="button"
                className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded opacity-60 hover:bg-accent hover:opacity-100"
                aria-label={`Close ${tab.name}`}
                onClick={() => close(tab.id)}
              >
                <IconX className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="min-h-0 flex-1">
          <AnimatePresence mode="wait">
            <motion.div
              key={isGenerating ? 'generating' : (activeTab?.id ?? 'empty')}
              className="h-full"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
            >
              {isGenerating ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
                  <IconFileOff className="size-8" />
                  <p className="text-sm">{t('workspacePreview.generating')}</p>
                </div>
              ) : (
                <>
                  {activeTab?.kind === 'file' && (
                    <FilePreview tab={activeTab} />
                  )}
                  {activeTab?.kind === 'artifact' && (
                    <HtmlArtifact
                      code={artifact.code}
                      streaming={artifact.streaming}
                      fill
                      showActions={false}
                    />
                  )}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </section>
    </div>
  )
}
