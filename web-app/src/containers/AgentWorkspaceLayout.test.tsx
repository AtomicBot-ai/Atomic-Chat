import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentWorkspaceLayout } from './AgentWorkspaceLayout'
import { useArtifactStore } from '@/stores/artifact-store'
import { useWorkspacePreviewStore } from '@/stores/workspace-preview-store'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useHeaderOverlay } from '@/stores/header-overlay-store'
import { useRunSettingsPanel } from '@/stores/run-settings-panel-store'

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

vi.mock('./RunSettingsPanel', () => ({
  RunSettingsPanel: ({ onClose }: { onClose: () => void }) => (
    <div>
      Run settings
      <button type="button" onClick={onClose}>
        Close run settings
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
    useHeaderOverlay.getState().setRightOverlayButtons(0)
    useRunSettingsPanel.getState().close()
    useGeneralSetting.setState({ agentModeEnabled: true })
  })

  it('offers the files sidebar only while agent mode is on', async () => {
    useGeneralSetting.setState({ agentModeEnabled: false })
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

    // A plain chat: run settings only, and the header clears one button.
    expect(
      screen.getByRole('button', { name: 'chat:runSettings.open' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Open files sidebar' })
    ).not.toBeInTheDocument()
    await waitFor(() => {
      expect(useHeaderOverlay.getState().rightOverlayButtons).toBe(1)
    })

    // Switching agent mode on brings the files toggle in; off again while the
    // files are open closes them.
    act(() => {
      useGeneralSetting.setState({ agentModeEnabled: true })
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open files sidebar' })
    )
    expect(await screen.findByText('Files')).toBeInTheDocument()

    act(() => {
      useGeneralSetting.setState({ agentModeEnabled: false })
    })
    await waitFor(() => {
      expect(screen.queryByText('Files')).not.toBeInTheDocument()
    })
    expect(
      screen.queryByRole('button', { name: 'Open files sidebar' })
    ).not.toBeInTheDocument()
  })

  it('tells the header how many corner buttons hang over it', async () => {
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

    // Sidebar closed: both floating buttons land on the header's corner.
    await waitFor(() => {
      expect(useHeaderOverlay.getState().rightOverlayButtons).toBe(2)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Open files sidebar' }))
    expect(await screen.findByText('Files')).toBeInTheDocument()
    await waitFor(() => {
      expect(useHeaderOverlay.getState().rightOverlayButtons).toBe(0)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Close files sidebar' }))
    await waitFor(() => {
      expect(useHeaderOverlay.getState().rightOverlayButtons).toBe(2)
    })

    // A preview panel takes that edge instead, so the buttons no longer land
    // on the header.
    act(() => {
      useArtifactStore.getState().open('source', '<h1>Artifact</h1>')
    })
    await waitFor(() => {
      expect(useHeaderOverlay.getState().rightOverlayButtons).toBe(0)
    })

    unmount()
    expect(useHeaderOverlay.getState().rightOverlayButtons).toBe(0)
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
    expect(screen.getByTestId('panel-agent-sidebar')).toHaveAttribute(
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

  it('offers only the run settings toggle when files are disabled', async () => {
    render(
      <AgentWorkspaceLayout
        threadId="home"
        workspace={{ externalRoots: [] }}
        onAddExternal={onAddExternal}
        refreshKey={0}
        filesEnabled={false}
      >
        <div>Home</div>
      </AgentWorkspaceLayout>
    )

    expect(
      screen.getByRole('button', { name: 'chat:runSettings.open' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Open files sidebar' })
    ).not.toBeInTheDocument()
    await waitFor(() => {
      expect(useHeaderOverlay.getState().rightOverlayButtons).toBe(1)
    })
  })

  it('opens and closes the run settings, hiding the corner buttons meanwhile', async () => {
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

    expect(screen.queryByText('Run settings')).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'chat:runSettings.open' })
    )
    expect(await screen.findByText('Run settings')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'chat:runSettings.open' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Open files sidebar' })
    ).not.toBeInTheDocument()
    await waitFor(() => {
      expect(panelLayouts.values.at(-1)).toEqual([76, 0, 24])
    })

    fireEvent.click(screen.getByRole('button', { name: 'Close run settings' }))
    await waitFor(() => {
      expect(screen.queryByText('Run settings')).not.toBeInTheDocument()
    })
    expect(
      screen.getByRole('button', { name: 'chat:runSettings.open' })
    ).toBeInTheDocument()
  })

  it('lets files and run settings take turns in the right column', async () => {
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

    fireEvent.click(
      screen.getByRole('button', { name: 'chat:runSettings.open' })
    )
    expect(await screen.findByText('Run settings')).toBeInTheDocument()

    // Closing the settings brings the corner buttons back; opening files from
    // there is the only route to the files panel, and it takes the column.
    fireEvent.click(screen.getByRole('button', { name: 'Close run settings' }))
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open files sidebar' })
    )
    expect(await screen.findByText('Files')).toBeInTheDocument()
    // The settings panel may still be sliding out; it must end up gone.
    await waitFor(() => {
      expect(screen.queryByText('Run settings')).not.toBeInTheDocument()
    })
    expect(useRunSettingsPanel.getState().isOpen).toBe(false)
  })

  it('keeps run settings open across a thread switch while files reset', async () => {
    const { rerender } = render(
      <AgentWorkspaceLayout
        threadId="thread-a"
        workspace={agentWorkspace}
        onAddExternal={onAddExternal}
        refreshKey={0}
      >
        <div>Chat</div>
      </AgentWorkspaceLayout>
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'chat:runSettings.open' })
    )
    expect(await screen.findByText('Run settings')).toBeInTheDocument()

    rerender(
      <AgentWorkspaceLayout
        threadId="thread-b"
        workspace={agentWorkspace}
        onAddExternal={onAddExternal}
        refreshKey={0}
      >
        <div>Chat</div>
      </AgentWorkspaceLayout>
    )
    expect(await screen.findByText('Run settings')).toBeInTheDocument()

    // Files, on the other hand, close on a thread switch and hand the column
    // back to the settings that were left open.
    fireEvent.click(screen.getByRole('button', { name: 'Close run settings' }))
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open files sidebar' })
    )
    expect(await screen.findByText('Files')).toBeInTheDocument()
    rerender(
      <AgentWorkspaceLayout
        threadId="thread-c"
        workspace={agentWorkspace}
        onAddExternal={onAddExternal}
        refreshKey={0}
      >
        <div>Chat</div>
      </AgentWorkspaceLayout>
    )
    await waitFor(() => {
      expect(screen.queryByText('Files')).not.toBeInTheDocument()
    })
    expect(
      screen.getByRole('button', { name: 'chat:runSettings.open' })
    ).toBeInTheDocument()
  })
})
