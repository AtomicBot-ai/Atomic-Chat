import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskComposer } from '../TaskComposer'
import { useAgentMode } from '@/hooks/useAgentMode'
import { usePrompt } from '@/hooks/usePrompt'
import { useInitialMessage } from '@/hooks/useInitialMessage'
import type { SecureEnvironment } from '@/services/chat-exec/types'

const { navigate, dialog, create, persist, policy } = vi.hoisted(() => ({
  navigate: vi.fn(),
  dialog: vi.fn(),
  create: vi.fn(),
  persist: vi.fn(),
  policy: vi.fn<() => SecureEnvironment | undefined>(),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ dialog: () => ({ open: dialog }) }),
}))
vi.mock('@/hooks/useTools', () => ({ useTools: () => undefined }))
vi.mock('@/hooks/useSecureEnvironments', () => ({
  useComposerSecureEnvironment: policy,
}))
vi.mock('@/utils/servedModel', () => ({
  servedModel: () => ({ model: 'model', provider: 'strata' }),
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: { getState: () => ({}) },
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: {
    getState: () => ({ createThread: create, awaitThreadPersistence: persist }),
  },
}))
vi.mock('@/hooks/useAssistant', () => ({
  useAssistant: {
    getState: () => ({
      assistants: [
        { id: 'default', instructions: 'Help' },
        { id: 'helper', instructions: 'Proofread' },
      ],
      defaultAssistantId: 'default',
      setPendingAssistant: vi.fn(),
    }),
  },
}))
vi.mock('@/services/agent/tauri', () => ({
  resolveAgentWorkspaceRoot: async (path: string) => ({
    rootId: 'root',
    path,
    name: 'repo',
    canEdit: true,
  }),
}))
vi.mock('@/containers/ChatInput', () => ({
  default: ({
    onSubmit,
    composerKey,
  }: {
    onSubmit: (text: string) => void
    composerKey: string
  }) => (
    <button onClick={() => onSubmit('Review this project')}>
      {composerKey}
    </button>
  ),
}))

const project = {
  id: 'shared',
  name: 'Shared project',
  updated_at: 42,
  assistantId: 'helper',
}
beforeEach(() => {
  vi.clearAllMocks()
  useAgentMode.setState({ workspaces: {}, approvalModes: {} })
  usePrompt.getState().setDraft('pi-agent-project:shared', '')
  create.mockResolvedValue({ id: 'task' })
  persist.mockResolvedValue(undefined)
  dialog.mockResolvedValue('/repo')
  policy.mockReturnValue(undefined)
})

describe('creating a task', () => {
  it('persists the chat project and its assistant before opening the task', async () => {
    let saved!: () => void
    persist.mockReturnValue(
      new Promise<void>((resolve) => {
        saved = resolve
      })
    )
    render(<TaskComposer project={project} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(persist).toHaveBeenCalledWith('task'))
    expect(navigate).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledWith(
      { id: 'model', provider: 'strata' },
      'Review this project',
      { id: 'helper', instructions: 'Proofread' },
      { id: 'shared', name: 'Shared project', updated_at: 42 },
      false,
      { kind: 'agent', agent: { cwd: '/repo' } }
    )
    saved()
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: '/agent/$threadId',
        params: { threadId: 'task' },
      })
    )
    expect(useInitialMessage.getState().consume('task')?.text).toBe(
      'Review this project'
    )
  })

  it('keeps a cancelled project draft out of the standalone task composer', async () => {
    dialog.mockResolvedValue(null)
    render(<TaskComposer project={project} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() =>
      expect(usePrompt.getState().getDraft('pi-agent-project:shared')).toBe(
        'Review this project'
      )
    )
    expect(usePrompt.getState().getDraft('pi-agent-home')).toBe('')
    expect(create).not.toHaveBeenCalled()
  })

  it('uses the native scratch folder in a secure project with no shared folder', async () => {
    policy.mockReturnValue({
      folders: [],
      network: false,
      allowedMcpServers: [],
    })
    render(<TaskComposer project={project} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(navigate).toHaveBeenCalled())
    expect(dialog).not.toHaveBeenCalled()
    expect(create.mock.calls[0][5]).toEqual({
      kind: 'agent',
      agent: { cwd: '' },
    })
  })

  it('binds the draft assistant when starting a standalone task', async () => {
    render(<TaskComposer />)
    fireEvent.click(screen.getByRole('button', { name: 'pi-agent-home' }))
    await waitFor(() => expect(navigate).toHaveBeenCalled())
    expect(create.mock.calls[0].slice(2, 4)).toEqual([
      { id: 'default', instructions: 'Help' },
      undefined,
    ])
  })
})
