import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}))

vi.mock('@janhq/core', () => ({ fs: { writeFileSync: vi.fn() } }))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ dialog: () => ({ save: vi.fn() }) }),
}))

vi.mock('@/lib/platform/utils', () => ({ isPlatformTauri: () => false }))

vi.mock('@/services/agent/tauri', () => ({
  readAgentWorkspaceText: vi.fn(),
  statAgentWorkspaceFile: vi.fn(),
}))

vi.mock('@/components/ai-elements/code-block', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

import { useArtifactStore } from '@/stores/artifact-store'
import { useWorkspacePreviewStore } from '@/stores/workspace-preview-store'
import { AgentWorkspacePreview } from '../AgentWorkspacePreview'

describe('AgentWorkspacePreview', () => {
  afterEach(() => {
    useWorkspacePreviewStore.getState().reset()
    useArtifactStore.getState().close()
  })

  it('offers Copy for an HTML artifact in the workspace preview (#280)', () => {
    useArtifactStore.getState().open('message-1', '<div>done</div>')
    useWorkspacePreviewStore.getState().openArtifact('page.html')

    render(<AgentWorkspacePreview />)

    expect(screen.getByTitle('Copy code')).toBeInTheDocument()
  })
})
