import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelGroupHandle,
} from 'react-resizable-panels'
import { AnimatePresence, motion } from 'motion/react'
import { PanelRight } from 'lucide-react'
import { AgentWorkspaceFiles } from './AgentWorkspaceFiles'
import { AgentWorkspacePreview } from './AgentWorkspacePreview'
import { ArtifactPanel } from './ArtifactPanel'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useDesktopScreen } from '@/hooks/useMediaQuery'
import { listAgentWorkspace } from '@/services/agent/tauri'
import { useArtifactStore } from '@/stores/artifact-store'
import { useWorkspacePreviewStore } from '@/stores/workspace-preview-store'
import type { AgentWorkspace, AgentWorkspaceRoot } from '@/hooks/useAgentMode'

type AgentWorkspaceLayoutProps = {
  children: ReactNode
  threadId: string
  agentModeActive: boolean
  workspace: AgentWorkspace
  onAddExternal: () => void
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

const RIGHT_PANEL_TRANSITION = {
  duration: 0.2,
  ease: 'linear' as const,
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
  workspace,
  onAddExternal,
  refreshKey,
  isGenerating = false,
}: AgentWorkspaceLayoutProps) {
  const isDesktop = useDesktopScreen()
  const tabs = useWorkspacePreviewStore((state) => state.tabs)
  const artifactOpen = useArtifactStore((state) => state.isOpen)
  const artifactTitle = useArtifactStore((state) => state.title)
  const [filesOpen, setFilesOpen] = useState(false)
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null)
  const workspaceRef = useRef<HTMLElement>(null)
  const sidebarWidth = useRef(useLeftPanel.getState().width)
  const workspaceKeyRef = useRef<string | undefined>(undefined)
  const previousWorkspaceHasEntriesRef = useRef<boolean | undefined>(undefined)

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
  }, [threadId, workspace.primaryRoot?.rootId])

  useEffect(() => {
    if (!agentModeActive || !isDesktop) return

    const roots = [workspace.primaryRoot, ...workspace.externalRoots].filter(
      (root): root is AgentWorkspaceRoot => Boolean(root)
    )
    const workspaceKey = `${threadId}\0${roots.map((root) => root.rootId).join('\0')}`
    if (workspaceKeyRef.current !== workspaceKey) {
      workspaceKeyRef.current = workspaceKey
      previousWorkspaceHasEntriesRef.current = undefined
      setFilesOpen(false)
    }

    let cancelled = false
    void Promise.all(
      roots.map((root) =>
        listAgentWorkspace({
          rootId: root.rootId,
          rootPath: root.path,
        }).catch(() => [])
      )
    ).then(
      (rootEntries) => {
        if (cancelled) return
        const hasEntries =
          workspace.externalRoots.length > 0 ||
          rootEntries.some((entries) => entries.length > 0)
        const previouslyHadEntries = previousWorkspaceHasEntriesRef.current

        if (!hasEntries) {
          setFilesOpen(false)
        } else if (previouslyHadEntries !== true) {
          setFilesOpen(true)
        }
        previousWorkspaceHasEntriesRef.current = hasEntries
      },
      () => {
        if (cancelled || previousWorkspaceHasEntriesRef.current !== undefined)
          return
        setFilesOpen(false)
      }
    )

    return () => {
      cancelled = true
    }
  }, [
    agentModeActive,
    isDesktop,
    refreshKey,
    threadId,
    workspace.externalRoots,
    workspace.primaryRoot,
  ])

  useEffect(
    () => () => {
      useWorkspacePreviewStore.getState().reset()
      useArtifactStore.getState().close()
    },
    []
  )

  const hasPreview = tabs.length > 0
  const filesVisible = filesOpen
  const initialPreviewSize = hasPreview ? 24 : 0
  const initialFilesSize = filesVisible ? 24 : 0
  const initialChatSize = 100 - initialPreviewSize - initialFilesSize

  useLayoutEffect(() => {
    if (!agentModeActive || !isDesktop) return

    const previewSize = hasPreview ? 24 : 0
    const workspaceWidth = workspaceRef.current?.getBoundingClientRect().width
    const sidebarWidthPx = cssLengthToPixels(sidebarWidth.current)
    const matchingSidebarSize =
      workspaceWidth && sidebarWidthPx
        ? (sidebarWidthPx / workspaceWidth) * 100
        : 24
    const filesSize = filesVisible
      ? Math.min(40, Math.max(8, matchingSidebarSize))
      : 0
    panelGroupRef.current?.setLayout([
      100 - previewSize - filesSize,
      previewSize,
      filesSize,
    ])
  }, [agentModeActive, filesVisible, hasPreview, isDesktop])

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
      {!filesVisible && (
        <button
          type="button"
          className="absolute top-[17px] right-3 z-30 flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none ring-ring transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2"
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
        <Panel
          id="agent-chat"
          order={1}
          defaultSize={initialChatSize}
          minSize={32}
          className="transition-[flex-grow] duration-200 ease-linear"
        >
          <div className="flex h-full min-w-0">{children}</div>
        </Panel>
        <ResizeHandle hidden={!hasPreview} />
        <Panel
          id="agent-preview"
          order={2}
          defaultSize={initialPreviewSize}
          minSize={24}
          collapsedSize={0}
          collapsible
          className="overflow-hidden transition-[flex-grow] duration-200 ease-linear"
        >
          <AnimatePresence initial={false}>
            {hasPreview && (
              <motion.div
                key="agent-preview"
                className="h-full"
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={RIGHT_PANEL_TRANSITION}
              >
                <AgentWorkspacePreview isGenerating={isGenerating} />
              </motion.div>
            )}
          </AnimatePresence>
        </Panel>
        <ResizeHandle hidden={!filesVisible} />
        <Panel
          id="agent-files"
          order={3}
          defaultSize={initialFilesSize}
          minSize={8}
          maxSize={40}
          collapsedSize={0}
          collapsible
          className="overflow-hidden transition-[flex-grow] duration-200 ease-linear"
        >
          <AnimatePresence initial={false}>
            {filesVisible && (
              <motion.div
                key="agent-files"
                className="h-full"
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={RIGHT_PANEL_TRANSITION}
              >
                <AgentWorkspaceFiles
                  threadId={threadId}
                  workspace={workspace}
                  refreshKey={refreshKey}
                  isGenerating={Boolean(isGenerating)}
                  onClose={() => setFilesOpen(false)}
                  onAddExternal={onAddExternal}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </Panel>
      </PanelGroup>
    </main>
  )
}
