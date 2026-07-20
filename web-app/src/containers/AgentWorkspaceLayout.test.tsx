import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentWorkspaceLayout } from './AgentWorkspaceLayout'
import { useArtifactStore } from '@/stores/artifact-store'
import { useWorkspacePreviewStore } from '@/stores/workspace-preview-store'

const media = vi.hoisted(() => ({ desktop: true }))

vi.mock('@/hooks/useMediaQuery', () => ({
  useDesktopScreen: () => media.desktop,
}))

vi.mock('react-resizable-panels', () => ({
  PanelGroup: ({ children }: { children: ReactNode }) => <>{children}</>,
  Panel: ({ children, id }: { children: ReactNode; id: string }) => (
    <div data-testid={`panel-${id}`}>{children}</div>
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
    useArtifactStore.getState().close()
    useWorkspacePreviewStore.getState().reset()
  })

  it('uses the workspace layout only for desktop Agent threads', () => {
    const agentLayout = render(
      <AgentWorkspaceLayout threadId="agent" agentModeActive refreshKey={0}>
        <div>Agent chat</div>
      </AgentWorkspaceLayout>
    )
    expect(screen.getByText('Files')).toBeInTheDocument()
    expect(screen.getByTestId('panel-agent-preview')).toBeInTheDocument()
    expect(screen.queryByText('Artifact panel')).not.toBeInTheDocument()
    expect(screen.getByText('Agent chat').parentElement).toHaveClass(
      'flex',
      'h-full'
    )
    agentLayout.unmount()

    const chatLayout = render(
      <AgentWorkspaceLayout
        threadId="chat"
        agentModeActive={false}
        refreshKey={0}
      >
        <div>Chat</div>
      </AgentWorkspaceLayout>
    )
    expect(screen.queryByText('Files')).not.toBeInTheDocument()
    expect(screen.getByText('Artifact panel')).toBeInTheDocument()
    chatLayout.unmount()

    media.desktop = false
    render(
      <AgentWorkspaceLayout threadId="narrow" agentModeActive refreshKey={0}>
        <div>Narrow Agent chat</div>
      </AgentWorkspaceLayout>
    )
    expect(screen.queryByText('Files')).not.toBeInTheDocument()
    expect(screen.getByText('Artifact panel')).toBeInTheDocument()
  })

  it('projects an opened HTML artifact into the shared preview tabs', async () => {
    render(
      <AgentWorkspaceLayout threadId="thread" agentModeActive refreshKey={0}>
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

  it('closes and reopens the files sidebar', () => {
    render(
      <AgentWorkspaceLayout threadId="thread" agentModeActive refreshKey={0}>
        <div>Chat</div>
      </AgentWorkspaceLayout>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close files sidebar' }))
    expect(screen.queryByText('Files')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open files sidebar' }))
    expect(screen.getByText('Files')).toBeInTheDocument()
  })
})
