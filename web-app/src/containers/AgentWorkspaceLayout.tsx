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
import { PanelRight, SlidersHorizontal } from 'lucide-react'
import { AgentWorkspaceFiles } from './AgentWorkspaceFiles'
import { AgentWorkspacePreview } from './AgentWorkspacePreview'
import { ArtifactPanel } from './ArtifactPanel'
import { RunSettingsPanel } from './RunSettingsPanel'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useDesktopScreen } from '@/hooks/useMediaQuery'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useArtifactStore } from '@/stores/artifact-store'
import { useWorkspacePreviewStore } from '@/stores/workspace-preview-store'
import { useHeaderOverlay } from '@/stores/header-overlay-store'
import { useRunSettingsPanel } from '@/stores/run-settings-panel-store'
import type { AgentWorkspace, AgentWorkspaceRoot } from '@/hooks/useAgentMode'

type AgentWorkspaceLayoutProps = {
  children: ReactNode
  threadId: string
  workspace: AgentWorkspace
  onAddExternal: () => void
  refreshKey: number
  isGenerating?: boolean
  /**
   * Whether the files sidebar (and its corner toggle) may be offered at all.
   * The home composer has no thread, hence no workspace to browse, and shows
   * only the run settings in its right column. Even where allowed, the files
   * sidebar only appears while agent mode is on — a plain chat has no agent
   * workspace to look at.
   */
  filesEnabled?: boolean
}

// The 3-panel workspace layout is now universal — every thread runs on the
// agent engine; only small screens fall back to a plain main.
function shouldUseAgentWorkspaceLayout(isDesktop: boolean): boolean {
  return isDesktop
}

function ResizeHandle({ hidden = false }: { hidden?: boolean }) {
  return (
    <PanelResizeHandle
      className={`group relative z-20 -mx-2 w-4 cursor-ew-resize border-0 bg-transparent p-0 outline-none transition-all ease-linear ${hidden ? 'invisible pointer-events-none' : ''}`}
    />
  )
}

const CORNER_BUTTON_CLASS =
  'flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none ring-ring transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2'

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
  workspace,
  onAddExternal,
  refreshKey,
  isGenerating = false,
  filesEnabled = true,
}: AgentWorkspaceLayoutProps) {
  const { t } = useTranslation()
  const isDesktop = useDesktopScreen()
  const tabs = useWorkspacePreviewStore((state) => state.tabs)
  const artifactOpen = useArtifactStore((state) => state.isOpen)
  const artifactTitle = useArtifactStore((state) => state.title)
  const [filesOpen, setFilesOpen] = useState(false)
  const agentModeEnabled = useGeneralSetting((state) => state.agentModeEnabled)
  const filesAvailable = filesEnabled && agentModeEnabled
  const settingsOpen = useRunSettingsPanel((state) => state.isOpen)
  const openSettings = useRunSettingsPanel((state) => state.open)
  const closeSettings = useRunSettingsPanel((state) => state.close)
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null)
  const workspaceRef = useRef<HTMLElement>(null)
  const sidebarWidth = useRef(useLeftPanel.getState().width)
  const workspaceKeyRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!isDesktop) {
      useWorkspacePreviewStore.getState().removeArtifact()
      return
    }
    if (artifactOpen) {
      useWorkspacePreviewStore.getState().openArtifact(artifactTitle)
    } else {
      useWorkspacePreviewStore.getState().removeArtifact()
    }
  }, [artifactOpen, artifactTitle, isDesktop])

  useEffect(() => {
    useWorkspacePreviewStore.getState().reset()
    useArtifactStore.getState().close()
  }, [threadId, workspace.primaryRoot?.rootId])

  // The files sidebar stays closed until it is asked for: a chat opens at full
  // width and keeps it, even once the agent has written files into the
  // workspace. Switching threads (or swapping roots) drops it back to closed.
  useEffect(() => {
    const roots = [workspace.primaryRoot, ...workspace.externalRoots].filter(
      (root): root is AgentWorkspaceRoot => Boolean(root)
    )
    const workspaceKey = `${threadId}\0${roots.map((root) => root.rootId).join('\0')}`
    if (workspaceKeyRef.current === workspaceKey) return
    workspaceKeyRef.current = workspaceKey
    setFilesOpen(false)
  }, [threadId, workspace.externalRoots, workspace.primaryRoot])

  useEffect(
    () => () => {
      useWorkspacePreviewStore.getState().reset()
      useArtifactStore.getState().close()
    },
    []
  )

  const hasPreview = tabs.length > 0
  // Files and run settings share one right column: opening one closes the
  // other. Files win the slot while open (a thread switch, or turning agent
  // mode off, drops them, which then reveals run settings again if those were
  // left open).
  const filesVisible = filesAvailable && filesOpen
  const rightPanel: 'files' | 'settings' | null = filesVisible
    ? 'files'
    : settingsOpen
      ? 'settings'
      : null
  const showFiles = () => {
    closeSettings()
    setFilesOpen(true)
  }
  const showSettings = () => {
    setFilesOpen(false)
    openSettings()
  }

  // The corner buttons below float against the window's right edge instead of
  // living in the header, so the header's own right-aligned controls have to be
  // told when they land on top of it. That is only while the chat column runs
  // the full width — with a preview panel open the buttons hang over that
  // panel, not over the header.
  const cornerButtonsOverHeader =
    shouldUseAgentWorkspaceLayout(isDesktop) &&
    rightPanel === null &&
    !hasPreview
  const cornerButtonCount = cornerButtonsOverHeader
    ? filesAvailable
      ? 2
      : 1
    : 0
  const setRightOverlayButtons = useHeaderOverlay(
    (state) => state.setRightOverlayButtons
  )
  useEffect(() => {
    setRightOverlayButtons(cornerButtonCount)
    return () => setRightOverlayButtons(0)
  }, [cornerButtonCount, setRightOverlayButtons])
  const initialPreviewSize = hasPreview ? 24 : 0
  const initialSidebarSize = rightPanel ? 24 : 0
  const initialChatSize = 100 - initialPreviewSize - initialSidebarSize

  useLayoutEffect(() => {
    if (!isDesktop) return

    const previewSize = hasPreview ? 24 : 0
    const workspaceWidth = workspaceRef.current?.getBoundingClientRect().width
    const sidebarWidthPx = cssLengthToPixels(sidebarWidth.current)
    const matchingSidebarSize =
      workspaceWidth && sidebarWidthPx
        ? (sidebarWidthPx / workspaceWidth) * 100
        : 24
    // Files follow the left sidebar's width; run settings need room for
    // their sliders, so they never go below a fifth of the workspace.
    const sidebarSize =
      rightPanel === 'files'
        ? Math.min(40, Math.max(8, matchingSidebarSize))
        : rightPanel === 'settings'
          ? Math.min(40, Math.max(20, matchingSidebarSize))
          : 0
    panelGroupRef.current?.setLayout([
      100 - previewSize - sidebarSize,
      previewSize,
      sidebarSize,
    ])
  }, [rightPanel, hasPreview, isDesktop])

  if (!shouldUseAgentWorkspaceLayout(isDesktop)) {
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
      {rightPanel === null && (
        // top-3.5 centres these 32px buttons on the h-15 (60px) page header,
        // so they line up with the header's own controls — the context gauge
        // sits right beside them.
        <div className="absolute top-3.5 right-3 z-30 flex items-center gap-2">
          <button
            type="button"
            className={CORNER_BUTTON_CLASS}
            aria-label={t('chat:runSettings.open')}
            title={t('chat:runSettings.open')}
            onClick={showSettings}
          >
            <SlidersHorizontal className="size-4" />
          </button>
          {filesAvailable && (
            <button
              type="button"
              className={CORNER_BUTTON_CLASS}
              aria-label="Open files sidebar"
              title="Open files sidebar"
              onClick={showFiles}
            >
              <PanelRight className="size-4" />
            </button>
          )}
        </div>
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
        <ResizeHandle hidden={rightPanel === null} />
        <Panel
          id="agent-sidebar"
          order={3}
          defaultSize={initialSidebarSize}
          minSize={8}
          maxSize={40}
          collapsedSize={0}
          collapsible
          className="overflow-hidden transition-[flex-grow] duration-200 ease-linear"
        >
          <AnimatePresence initial={false}>
            {rightPanel === 'files' && (
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
            {rightPanel === 'settings' && (
              <motion.div
                key="run-settings"
                className="h-full"
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={RIGHT_PANEL_TRANSITION}
              >
                <RunSettingsPanel onClose={closeSettings} />
              </motion.div>
            )}
          </AnimatePresence>
        </Panel>
      </PanelGroup>
    </main>
  )
}
