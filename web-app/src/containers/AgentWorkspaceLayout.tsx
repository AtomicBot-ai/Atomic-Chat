import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { PanelRight } from 'lucide-react'
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from 'react-resizable-panels'
import { AgentWorkspaceFiles } from './AgentWorkspaceFiles'
import { AgentWorkspacePreview } from './AgentWorkspacePreview'
import { ArtifactPanel } from './ArtifactPanel'
import { useDesktopScreen } from '@/hooks/useMediaQuery'
import { useArtifactStore } from '@/stores/artifact-store'
import { useWorkspacePreviewStore } from '@/stores/workspace-preview-store'

type AgentWorkspaceLayoutProps = {
  children: ReactNode
  threadId: string
  agentModeActive: boolean
  workingDir?: string
  refreshKey: number
}

function shouldUseAgentWorkspaceLayout(
  agentModeActive: boolean,
  isDesktop: boolean
): boolean {
  return agentModeActive && isDesktop
}

function ResizeHandle({ hidden = false }: { hidden?: boolean }) {
  return (
    <PanelResizeHandle
      className={`group relative w-px bg-border outline-none ${hidden ? 'invisible pointer-events-none' : ''}`}
    >
      <div className="absolute inset-y-0 -left-1.5 w-3 group-data-[resize-handle-active]:bg-primary/10" />
    </PanelResizeHandle>
  )
}

export function AgentWorkspaceLayout({
  children,
  threadId,
  agentModeActive,
  workingDir,
  refreshKey,
}: AgentWorkspaceLayoutProps) {
  const isDesktop = useDesktopScreen()
  const tabs = useWorkspacePreviewStore((state) => state.tabs)
  const artifactOpen = useArtifactStore((state) => state.isOpen)
  const artifactTitle = useArtifactStore((state) => state.title)
  const [filesOpen, setFilesOpen] = useState(true)
  const previewPanelRef = useRef<ImperativePanelHandle>(null)

  useEffect(() => {
    if (!agentModeActive || !isDesktop) {
      useWorkspacePreviewStore.getState().removeArtifact()
      return
    }
    if (artifactOpen) {
      useWorkspacePreviewStore.getState().openArtifact(artifactTitle)
    } else {
      useWorkspacePreviewStore.getState().removeArtifact()
    }
  }, [agentModeActive, artifactOpen, artifactTitle, isDesktop])

  useEffect(() => {
    useWorkspacePreviewStore.getState().reset()
    useArtifactStore.getState().close()
  }, [threadId, workingDir])

  useEffect(
    () => () => {
      useWorkspacePreviewStore.getState().reset()
      useArtifactStore.getState().close()
    },
    []
  )

  const hasPreview = tabs.length > 0

  useLayoutEffect(() => {
    if (hasPreview) {
      previewPanelRef.current?.expand(32)
    } else {
      previewPanelRef.current?.collapse()
    }
  }, [hasPreview])

  if (!agentModeActive) {
    return (
      <main className="flex h-[calc(100dvh-(env(safe-area-inset-bottom)+env(safe-area-inset-top)))] w-full min-w-0 overflow-hidden">
        {children}
        <ArtifactPanel />
      </main>
    )
  }

  if (!shouldUseAgentWorkspaceLayout(agentModeActive, isDesktop)) {
    return (
      <main className="flex h-[calc(100dvh-(env(safe-area-inset-bottom)+env(safe-area-inset-top)))] w-full min-w-0 overflow-hidden">
        {children}
        <ArtifactPanel />
      </main>
    )
  }

  return (
    <main className="relative flex h-[calc(100dvh-(env(safe-area-inset-bottom)+env(safe-area-inset-top)))] w-full min-w-0 overflow-hidden">
      {!filesOpen && (
        <button
          type="button"
          className="absolute top-1.5 right-2 z-30 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Open files sidebar"
          title="Open files sidebar"
          onClick={() => setFilesOpen(true)}
        >
          <PanelRight className="size-4" />
        </button>
      )}
      <PanelGroup direction="horizontal" className="h-full w-full">
        <Panel id="agent-chat" order={1} defaultSize={76} minSize={32}>
          <div className="flex h-full min-w-0">{children}</div>
        </Panel>
        <ResizeHandle hidden={!hasPreview} />
        <Panel
          ref={previewPanelRef}
          id="agent-preview"
          order={2}
          defaultSize={0}
          minSize={24}
          collapsedSize={0}
          collapsible
        >
          {hasPreview && <AgentWorkspacePreview workingDir={workingDir} />}
        </Panel>
        {filesOpen && (
          <>
            <ResizeHandle />
            <Panel
              id="agent-files"
              order={3}
              defaultSize={24}
              minSize={16}
              maxSize={36}
            >
              <AgentWorkspaceFiles
                workingDir={workingDir}
                refreshKey={refreshKey}
                onClose={() => setFilesOpen(false)}
              />
            </Panel>
          </>
        )}
      </PanelGroup>
    </main>
  )
}
