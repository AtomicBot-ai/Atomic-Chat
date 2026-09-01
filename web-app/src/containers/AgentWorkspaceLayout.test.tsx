import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentWorkspaceLayout } from './AgentWorkspaceLayout'
import { useArtifactStore } from '@/stores/artifact-store'
import { useWorkspacePreviewStore } from '@/stores/workspace-preview-store'
import { useHeaderOverlay } from '@/stores/header-overlay-store'

const media = vi.hoisted(() => ({ desktop: true }))
const panelLayouts = vi.hoisted(() => ({ values: [] as number[][] }))
const agentWorkspace = {
  primaryRoot: {
    id: 'primary',
    path: '/workspace',
    name: 'workspace',
    canEdit: true,
  },
  externalRoots: [],
}
const onAddExternal = vi.fn()

vi.mock('@/hooks/useMediaQuery', () => ({
  useDesktopScreen: () => media.desktop,
}))

vi.mock('@/services/agent/tauri', () => ({
  listAgentWorkspace: vi.fn(async () => []),
}))

vi.mock('react-resizable-panels', () => ({
  PanelGroup: forwardRef(({ children }: { children: ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({
      getId: () => 'agent-workspace',
      getLayout: () => panelLayouts.values.at(-1) ?? [],
      setLayout: (layout: number[]) => panelLayouts.values.push(layout),
    }))
    return <>{children}</>
  }),
  Panel: ({
    children,
    id,
    defaultSize,
  }: {
    children: ReactNode
    id: string
    defaultSize: number
  }) => (
    <div data-testid={`panel-${id}`} data-default-size={defaultSize}>
      {children}
    </div>
  ),
  PanelResizeHandle: () => <div />,
}))

vi.mock('./AgentWorkspaceFiles', () => ({
  AgentWorkspaceFiles: ({ onClose }: { onClose: () => void }) => (
    <div>
      Files
      <button type="button" onClick={onClose}>
        Close files sidebar
      </button>
    </div>
  ),
}))

vi.mock('./ArtifactPanel', () => ({
  ArtifactPanel: () => <div>Artifact panel</div>,
}))

describe('AgentWorkspaceLayout', () => {
  beforeEach(() => {
    media.desktop = true
    panelLayouts.values = []
    useArtifactStore.getState().close()
    useWorkspacePreviewStore.getState().reset()
    useHeaderOverlay.getState().setRightOverlay(false)
  })

  it('flags the header while the files button hangs over its corner', async () => {
    const { unmount } = render(
      <AgentWorkspaceLayout
        threadId="thread"
        workspace={agentWorkspace}
        onAddExternal={onAddExternal}
        refreshKey={0}
      >
        <div>Chat</div>
      </AgentWorkspaceLayout>
    )

    // Sidebar closed: the floating button lands on the header's corner.
    await waitFor(() => {
      expect(useHeaderOverlay.getState().rightOverlay).toBe(true)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Open files sidebar' }))
    expect(await screen.findByText('Files')).toBeInTheDocument()
    await waitFor(() => {
      expect(useHeaderOverlay.getState().rightOverlay).toBe(false)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Close files sidebar' }))
    await waitFor(() => {
      expect(useHeaderOverlay.getState().rightOverlay).toBe(true)
    })

    // A preview panel takes that edge instead, so the button no longer lands on
    // the header.
    act(() => {
      useArtifactStore.getState().open('source', '<h1>Artifact</h1>')
    })
    await waitFor(() => {
      expect(useHeaderOverlay.getState().rightOverlay).toBe(false)
    })

    unmount()
    expect(useHeaderOverlay.getState().rightOverlay).toBe(false)
  })

  it('uses the workspace layout on desktop and falls back on narrow screens', async () => {
    const desktopLayout = render(
      <AgentWorkspaceLayout
        threadId="agent"
        workspace={agentWorkspace}
        onAddExternal={onAddExternal}
        refreshKey={0}
      >
        <div>Agent chat</div>
      </AgentWorkspaceLayout>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open files sidebar' }))
    expect(await screen.findByText('Files')).toBeInTheDocument()
    expect(screen.getByTestId('panel-agent-preview')).toBeInTheDocument()
    expect(screen.queryByText('Artifact panel')).not.toBeInTheDocument()
    expect(screen.getByText('Agent chat').parentElement).toHaveClass(
      'flex',
      'h-full'
    )
    desktopLayout.unmount()

    media.desktop = false
    render(
      <AgentWorkspaceLayout
        threadId="narrow"
        workspace={agentWorkspace}
        onAddExternal={onAddExternal}
        refreshKey={0}
      >
        <div>Narrow Agent chat</div>
      </AgentWorkspaceLayout>
    )
    expect(screen.queryByText('Files')).not.toBeInTheDocument()
    expect(screen.getByText('Artifact panel')).toBeInTheDocument()
  })

  it('projects an opened HTML artifact into the shared preview tabs', async () => {
    render(
      <AgentWorkspaceLayout
        threadId="thread"
        workspace={agentWorkspace}
        onAddExternal={onAddExternal}
        refreshKey={0}
      >
        <div>Chat</div>
      </AgentWorkspaceLayout>
    )

    act(() => {
      useArtifactStore.getState().open('source', '<h1>Artifact</h1>')
    })

    await waitFor(() => {
      expect(useWorkspacePreviewStore.getState().tabs).toEqual([
        { id: 'artifact', kind: 'artifact', name: 'HTML' },
      ])
    })
  })

  it('holds the preview until generation finishes', async () => {
    const { container } = render(
      <AgentWorkspaceLayout
        threadId="thread"
        workspace={agentWorkspace}
        onAddExternal={onAddExternal}
        refreshKey={0}
        isGenerating
      >
        <div>Chat</div>
      </AgentWorkspaceLayout>
    )

    act(() => {
      useArtifactStore.getState().open('source', '<h1>Artifact</h1>')
    })

    expect(
      await screen.findByText('chat:workspacePreview.generating')
    ).toBeInTheDocument()
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('opens and closes the files sidebar on demand', async () => {
    render(
      <AgentWorkspaceLayout
        threadId="thread"
        workspace={agentWorkspace}
        onAddExternal={onAddExternal}
        refreshKey={0}
      >
        <div>Chat</div>
      </AgentWorkspaceLayout>
    )

    expect(screen.queryByText('Files')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open files sidebar' }))
    expect(await screen.findByText('Files')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close files sidebar' }))
    await waitFor(() => {
      expect(screen.queryByText('Files')).not.toBeInTheDocument()
    })
  })

  it('keeps the files sidebar closed when the workspace gains an entry', async () => {
    const { rerender } = render(
      <AgentWorkspaceLayout
        threadId="thread"
        workspace={agentWorkspace}
        onAddExternal={onAddExternal}
        refreshKey={0}
      >
        <div>Chat</div>
      </AgentWorkspaceLayout>
    )

    await waitFor(() => {
      expect(screen.queryByText('Files')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Open files sidebar' })
      ).toBeInTheDocument()
    })

    rerender(
      <AgentWorkspaceLayout
        threadId="thread"
        workspace={agentWorkspace}
        onAddExternal={onAddExternal}
        refreshKey={1}
      >
        <div>Chat</div>
      </AgentWorkspaceLayout>
    )

    expect(
      await screen.findByRole('button', { name: 'Open files sidebar' })
    ).toBeInTheDocument()
    expect(screen.queryByText('Files')).not.toBeInTheDocument()
  })

  it('starts an Agent workspace at full chat width', async () => {
    render(
      <AgentWorkspaceLayout
        threadId="home"
        workspace={{ externalRoots: [] }}
        onAddExternal={onAddExternal}
        refreshKey={0}
      >
        <div>Agent home</div>
      </AgentWorkspaceLayout>
    )

    await waitFor(() => {
      expect(screen.queryByText('Files')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('panel-agent-chat')).toHaveAttribute(
      'data-default-size',
      '100'
    )
    expect(screen.getByTestId('panel-agent-files')).toHaveAttribute(
      'data-default-size',
      '0'
    )
  })

  it('keeps the files sidebar closed when an external folder is connected', async () => {
    render(
      <AgentWorkspaceLayout
        threadId="home"
        workspace={{
          externalRoots: [
            {
              rootId: 'external',
              path: '/external',
              name: 'external',
              canEdit: true,
            },
          ],
        }}
        onAddExternal={onAddExternal}
        refreshKey={0}
      >
        <div>Agent home</div>
      </AgentWorkspaceLayout>
    )

    expect(
      await screen.findByRole('button', { name: 'Open files sidebar' })
    ).toBeInTheDocument()
    expect(screen.queryByText('Files')).not.toBeInTheDocument()
  })

  it('opens preview space without changing the files panel width', async () => {
    render(
      <AgentWorkspaceLayout
        threadId="thread"
        workspace={agentWorkspace}
        onAddExternal={onAddExternal}
        refreshKey={0}
      >
        <div>Chat</div>
      </AgentWorkspaceLayout>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open files sidebar' }))
    expect(await screen.findByText('Files')).toBeInTheDocument()

    act(() => {
      useWorkspacePreviewStore.getState().openFile({
        rootId: 'primary',
        rootPath: '/workspace',
        relativePath: 'poem.txt',
      })
    })

    await waitFor(() => {
      expect(panelLayouts.values.at(-1)).toEqual([52, 24, 24])
    })
  })
})
