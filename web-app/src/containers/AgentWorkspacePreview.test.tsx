import { render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentWorkspacePreview } from './AgentWorkspacePreview'
import { useWorkspacePreviewStore } from '@/stores/workspace-preview-store'

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}))

vi.mock('@/services/agent/tauri', () => ({
  statAgentWorkspaceFile: vi.fn(
    async ({ relativePath }: { relativePath: string }) => ({
      absolutePath: `/workspace/${relativePath}`,
    })
  ),
  readAgentWorkspaceText: vi.fn(async () => ({
    content: 'hello',
    truncated: false,
  })),
}))

vi.mock('./HtmlArtifact', () => ({
  HtmlArtifact: () => <div>Artifact</div>,
}))

// The audio preview renders a Radix slider, which measures its thumb.
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function openFile(relativePath: string) {
  useWorkspacePreviewStore.getState().openFile({
    rootId: 'primary',
    rootPath: '/workspace',
    relativePath,
  })
}

describe('AgentWorkspacePreview media files', () => {
  beforeAll(() => {
    global.ResizeObserver =
      MockResizeObserver as unknown as typeof ResizeObserver
    // jsdom has no media pipeline; AudioPlayer calls load() on mount.
    HTMLMediaElement.prototype.load = vi.fn()
  })

  beforeEach(() => {
    useWorkspacePreviewStore.getState().reset()
  })

  it('plays a video file inline', async () => {
    openFile('clip.mp4')
    const { container } = render(<AgentWorkspacePreview />)

    await waitFor(() => {
      const video = container.querySelector('video')
      expect(video).not.toBeNull()
      expect(video).toHaveAttribute(
        'src',
        'asset://localhost//workspace/clip.mp4'
      )
      expect(video).toHaveAttribute('controls')
    })
  })

  it('plays an audio file inline', async () => {
    openFile('voice.mp3')
    const { container } = render(<AgentWorkspacePreview />)

    await waitFor(() => {
      const audio = container.querySelector('audio')
      expect(audio).not.toBeNull()
      expect(audio).toHaveAttribute(
        'src',
        'asset://localhost//workspace/voice.mp3'
      )
    })
  })

  it('still refuses formats the webview cannot decode', async () => {
    openFile('capture.mkv')
    render(<AgentWorkspacePreview />)

    expect(
      await screen.findByText('Preview is not available for this file type.')
    ).toBeInTheDocument()
  })
})
