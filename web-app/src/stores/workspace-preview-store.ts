import { create } from 'zustand'
import { agentPathBasename } from '@/lib/agent-path'

export type WorkspaceFilePreviewTab = {
  id: string
  kind: 'file'
  rootId: string
  rootPath: string
  relativePath: string
  name: string
}

export type WorkspaceArtifactPreviewTab = {
  id: 'artifact'
  kind: 'artifact'
  name: string
}

export type WorkspacePreviewTab =
  | WorkspaceFilePreviewTab
  | WorkspaceArtifactPreviewTab

type WorkspacePreviewState = {
  tabs: WorkspacePreviewTab[]
  activeTabId: string | null
  openFile: (file: {
    rootId: string
    rootPath: string
    relativePath: string
  }) => void
  openArtifact: (name?: string) => void
  closeTab: (id: string) => void
  removeArtifact: () => void
  reset: () => void
}

function fileTabId(rootId: string, relativePath: string): string {
  return `file:${rootId}:${relativePath}`
}

function fileName(path: string): string {
  return agentPathBasename(path)
}

function withoutTab(
  tabs: WorkspacePreviewTab[],
  id: string,
  activeTabId: string | null
): Pick<WorkspacePreviewState, 'tabs' | 'activeTabId'> {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index < 0) {
    return { tabs, activeTabId }
  }

  const nextTabs = tabs.filter((tab) => tab.id !== id)
  if (activeTabId !== id) {
    return { tabs: nextTabs, activeTabId }
  }

  const nextActive = nextTabs[Math.min(index, nextTabs.length - 1)]
  return {
    tabs: nextTabs,
    activeTabId: nextActive?.id ?? null,
  }
}

export const useWorkspacePreviewStore = create<WorkspacePreviewState>()(
  (set) => ({
    tabs: [],
    activeTabId: null,
    openFile: ({ rootId, rootPath, relativePath }) => {
      const id = fileTabId(rootId, relativePath)
      set((state) => {
        const nextTab: WorkspaceFilePreviewTab = {
          id,
          kind: 'file',
          rootId,
          rootPath,
          relativePath,
          name: fileName(relativePath),
        }
        const fileIndex = state.tabs.findIndex((tab) => tab.kind === 'file')

        return {
          tabs:
            fileIndex < 0
              ? [...state.tabs, nextTab]
              : state.tabs.map((tab, index) =>
                  index === fileIndex ? nextTab : tab
                ),
          activeTabId: id,
        }
      })
    },
    openArtifact: (name = 'Artifact') => {
      set((state) => {
        const existing = state.tabs.find((tab) => tab.id === 'artifact')
        if (existing) {
          return {
            tabs: state.tabs.map((tab) =>
              tab.id === 'artifact' ? { ...tab, name } : tab
            ),
            activeTabId: 'artifact',
          }
        }
        return {
          tabs: [...state.tabs, { id: 'artifact', kind: 'artifact', name }],
          activeTabId: 'artifact',
        }
      })
    },
    closeTab: (id) => {
      set((state) => withoutTab(state.tabs, id, state.activeTabId))
    },
    removeArtifact: () => {
      set((state) => withoutTab(state.tabs, 'artifact', state.activeTabId))
    },
    reset: () => set({ tabs: [], activeTabId: null }),
  })
)
