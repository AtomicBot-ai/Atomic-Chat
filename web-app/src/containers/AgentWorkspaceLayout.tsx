import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { PanelRight } from 'lucide-react'
import { motion } from 'motion/react'
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelGroupHandle,
} from 'react-resizable-panels'
import { AgentWorkspaceFiles } from './AgentWorkspaceFiles'
import { AgentWorkspacePreview } from './AgentWorkspacePreview'
import { ArtifactPanel } from './ArtifactPanel'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useDesktopScreen } from '@/hooks/useMediaQuery'
import { useArtifactStore } from '@/stores/artifact-store'
import { useWorkspacePreviewStore } from '@/stores/workspace-preview-store'

type AgentWorkspaceLayoutProps = {
  children: ReactNode
  threadId: string
  agentModeActive: boolean
  workingDir?: string
  refreshKey: number
  isGenerating?: boolean
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
      className={`group relative z-20 -mx-2 w-4 cursor-ew-resize border-0 bg-transparent p-0 outline-none transition-all ease-linear ${hidden ? 'invisible pointer-events-none' : ''}`}
    />
  )
}

function cssLengthToPixels(value: string): number | undefined {
  const match = value.trim().match(/^([\d.]+)(px|rem)$/)
  if (!match) return undefined

  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return undefined
  if (match[2] === 'px') return amount

  const rootFontSize = Number.parseFloat(
    window.getComputedStyle(document.documentElement).fontSize
  )
  return amount * (Number.isFinite(rootFontSize) ? rootFontSize : 16)
}

export function AgentWorkspaceLayout({
  children,
  threadId,
  agentModeActive,
  workingDir,
  refreshKey,
  isGenerating = false,
}: AgentWorkspaceLayoutProps) {
  const isDesktop = useDesktopScreen()
  const tabs = useWorkspacePreviewStore((state) => state.tabs)
  const artifactOpen = useArtifactStore((state) => state.isOpen)
  const artifactTitle = useArtifactStore((state) => state.title)
  const [filesOpen, setFilesOpen] = useState(true)
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null)
  const workspaceRef = useRef<HTMLElement>(null)
  const sidebarWidth = useRef(useLeftPanel.getState().width)

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
    if (!agentModeActive || !isDesktop) return

    const previewSize = hasPreview ? 24 : 0
    const workspaceWidth = workspaceRef.current?.getBoundingClientRect().width
    const sidebarWidthPx = cssLengthToPixels(sidebarWidth.current)
    const matchingSidebarSize =
      workspaceWidth && sidebarWidthPx
        ? (sidebarWidthPx / workspaceWidth) * 100
        : 24
    const filesSize = filesOpen
      ? Math.min(40, Math.max(8, matchingSidebarSize))
      : 0
    panelGroupRef.current?.setLayout([
      100 - previewSize - filesSize,
      previewSize,
      filesSize,
    ])
  }, [agentModeActive, filesOpen, hasPreview, isDesktop])

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
    <main
      ref={workspaceRef}
      className="relative flex h-[calc(100dvh-(env(safe-area-inset-bottom)+env(safe-area-inset-top)))] w-full min-w-0 overflow-hidden"
    >
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
      <PanelGroup
        ref={panelGroupRef}
        direction="horizontal"
        className="h-full w-full"
      >
        <Panel id="agent-chat" order={1} defaultSize={76} minSize={32}>
          <div className="flex h-full min-w-0">{children}</div>
        </Panel>
        <ResizeHandle hidden={!hasPreview} />
        <Panel
          id="agent-preview"
          order={2}
          defaultSize={0}
          minSize={24}
          collapsedSize={0}
          collapsible
        >
          {hasPreview && (
            <motion.div
              className="h-full"
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
              <AgentWorkspacePreview
                workingDir={workingDir}
                isGenerating={isGenerating}
              />
            </motion.div>
          )}
        </Panel>
        <ResizeHandle hidden={!filesOpen} />
        <Panel
          id="agent-files"
          order={3}
          defaultSize={24}
          minSize={8}
          maxSize={40}
          collapsedSize={0}
          collapsible
        >
          {filesOpen && (
            <motion.div
              className="h-full"
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
              <AgentWorkspaceFiles
                workingDir={workingDir}
                refreshKey={refreshKey}
                onClose={() => setFilesOpen(false)}
              />
            </motion.div>
          )}
        </Panel>
      </PanelGroup>
    </main>
  )
}
