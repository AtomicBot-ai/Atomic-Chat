import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import {
  useAgentMode,
  type AgentThreadState,
  type AgentWorkspace,
} from '@/hooks/useAgentMode'
import { useAppState } from '@/hooks/useAppState'
import { useToolApproval } from '@/hooks/useToolApproval'
import {
  resolveExecAutoApprove,
  resolveMcpAutoApprove,
} from '@/lib/mcp-approval'
import { useModelProvider } from '@/hooks/useModelProvider'
import { usePrompt } from '@/hooks/usePrompt'
import { useDeferredFirstSend } from '@/stores/deferred-first-send-store'
import { seedServiceHub } from '@/test/service-hub'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  switchToModel: vi.fn(() => Promise.resolve()),
  sendMessage: vi.fn(),
  addToolOutput: vi.fn(),
  createThread: vi.fn(),
  setThreadsState: vi.fn(),
  addMessage: vi.fn(),
  updateMessage: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  currentThreadId: 'existing-thread' as string | undefined,
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('@/utils/switchModel', () => ({
  switchToModel: mocks.switchToModel,
}))

vi.mock('@/hooks/use-chat', () => ({
  useChat: () => ({
    sendMessage: mocks.sendMessage,
    addToolOutput: mocks.addToolOutput,
  }),
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: {
    getState: () => ({
      currentThreadId: mocks.currentThreadId,
      createThread: mocks.createThread,
    }),
    setState: mocks.setThreadsState,
  },
}))

vi.mock('@/hooks/useMessages', () => ({
  useMessages: {
    getState: () => ({
      getMessages: () => [],
      addMessage: mocks.addMessage,
      updateMessage: mocks.updateMessage,
    }),
  },
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}))

import { DeferredFirstSendProvider } from '../DeferredFirstSendProvider'

describe('DeferredFirstSendProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState({}, '', '/settings/general')
    mocks.currentThreadId = 'existing-thread'
    mocks.createThread.mockResolvedValue({
      id: 'background-thread',
      title: 'Queued prompt',
      assistants: [],
    })
    seedServiceHub()
    usePrompt.setState({ prompt: 'Queued prompt', draftKey: null, drafts: {} })
    useDeferredFirstSend.setState({ queued: null })
    useAppState.setState({ activeModels: [] })
    useModelProvider.setState({
      providers: [],
      selectedProvider: '',
      selectedModel: null,
    })
  })

  it('starts the imported model and sends in a sidebar chat without navigating away', async () => {
    render(<DeferredFirstSendProvider />)
    act(() => {
      useDeferredFirstSend.getState().enqueue({
        id: 'queue-1',
        prompt: 'Queued prompt',
        downloadModelIds: ['LiquidAI/LFM2.5-2.6B-Q4_K_M'],
        createdAt: Date.now(),
      })
      useModelProvider.setState({
        providers: [
          {
            provider: 'llamacpp-upstream',
            active: true,
            models: [
              {
                id: 'LiquidAI/LFM2.5-2.6B-Q4_K_M',
                capabilities: [],
                settings: {},
              } as Model,
            ],
            settings: [],
          } as ModelProvider,
        ],
      })
    })

    await waitFor(() => expect(mocks.switchToModel).toHaveBeenCalled())
    act(() => {
      useAppState.setState({
        activeModels: ['LiquidAI/LFM2.5-2.6B-Q4_K_M'],
      })
    })

    await waitFor(() => expect(mocks.createThread).toHaveBeenCalled())
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalled())
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.setThreadsState).toHaveBeenCalledWith({
      currentThreadId: 'existing-thread',
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'chat:replyGate.backgroundStarted'
    )
    expect(usePrompt.getState().prompt).toBe('')
  })

  it('stands down while New Chat is mounted so its full send flow owns the turn', async () => {
    window.history.replaceState({}, '', '/')
    render(<DeferredFirstSendProvider />)
    act(() => {
      useDeferredFirstSend.getState().enqueue({
        id: 'queue-2',
        prompt: 'Queued prompt',
        downloadModelIds: ['owner/model'],
        createdAt: Date.now(),
      })
      useModelProvider.setState({
        providers: [
          {
            provider: 'llamacpp-upstream',
            active: true,
            models: [
              { id: 'owner/model', capabilities: [], settings: {} } as Model,
            ],
            settings: [],
          } as ModelProvider,
        ],
      })
      useAppState.setState({ activeModels: ['owner/model'] })
    })

    await act(async () => {})
    expect(mocks.switchToModel).not.toHaveBeenCalled()
    expect(mocks.createThread).not.toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
    // Hands off entirely: the composer's selection and draft are untouched,
    // and the queued send stays armed as the backup for leaving the route.
    expect(useModelProvider.getState().selectedProvider).toBe('')
    expect(useModelProvider.getState().selectedModel).toBeNull()
    expect(usePrompt.getState().prompt).toBe('Queued prompt')
    expect(useDeferredFirstSend.getState().queued?.id).toBe('queue-2')
  })

  it('clears the sent text from New Chat, not from the chat the user opened since', async () => {
    // The user left New Chat for another chat and started typing there; the
    // queued text waits, parked, in New Chat's composer.
    usePrompt.setState({
      prompt: 'My reply in the open chat',
      draftKey: 'existing-thread',
      drafts: { [TEMPORARY_CHAT_ID]: 'Queued prompt' },
    })
    render(<DeferredFirstSendProvider />)
    act(() => {
      useDeferredFirstSend.getState().enqueue({
        id: 'queue-3',
        prompt: 'Queued prompt',
        downloadModelIds: ['owner/model'],
        createdAt: Date.now(),
      })
      useModelProvider.setState({
        providers: [
          {
            provider: 'llamacpp-upstream',
            active: true,
            models: [
              { id: 'owner/model', capabilities: [], settings: {} } as Model,
            ],
            settings: [],
          } as ModelProvider,
        ],
      })
    })
    await waitFor(() => expect(mocks.switchToModel).toHaveBeenCalled())
    act(() => {
      useAppState.setState({ activeModels: ['owner/model'] })
    })

    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalled())
    // Sent, so New Chat no longer offers it again...
    expect(usePrompt.getState().getDraft(TEMPORARY_CHAT_ID)).toBe('')
    // ...and the open chat keeps what the user is typing.
    expect(usePrompt.getState().prompt).toBe('My reply in the open chat')
    expect(usePrompt.getState().draftKey).toBe('existing-thread')
  })

  describe("New Chat's approval mode and workspace at Send", () => {
    const workspace: AgentWorkspace = {
      primaryRoot: {
        rootId: 'root-1',
        path: '/Users/me/project',
        name: 'project',
        canEdit: true,
      },
      externalRoots: [],
    }

    // Send pressed on New Chat while the model downloads; the user leaves, and
    // the model comes up later.
    const sendAfterLeaving = async (agentState: AgentThreadState) => {
      render(<DeferredFirstSendProvider />)
      act(() => {
        useDeferredFirstSend.getState().enqueue({
          id: 'queue-agent',
          prompt: 'Queued prompt',
          downloadModelIds: ['owner/model'],
          createdAt: Date.now(),
          agentState,
        })
        useModelProvider.setState({
          providers: [
            {
              provider: 'llamacpp-upstream',
              active: true,
              models: [
                { id: 'owner/model', capabilities: [], settings: {} } as Model,
              ],
              settings: [],
            } as ModelProvider,
          ],
        })
      })
      await waitFor(() => expect(mocks.switchToModel).toHaveBeenCalled())
      act(() => {
        useAppState.setState({ activeModels: ['owner/model'] })
      })
      await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalled())
    }

    beforeEach(() => {
      // The global auto-approve switch is on, as it is for everyone.
      useToolApproval.setState({ allowAllMCPPermissions: true })
      useAgentMode.setState({ approvalModes: {}, workspaces: {} })
    })

    it('starts the background chat on the Restricted the user saw, so its tool calls ask', async () => {
      useAgentMode.setState({
        approvalModes: { [TEMPORARY_CHAT_ID]: 'manual' },
        workspaces: { [TEMPORARY_CHAT_ID]: workspace },
      })

      await sendAfterLeaving({ approvalMode: 'manual', workspace })

      const agent = useAgentMode.getState()
      expect(agent.approvalModes['background-thread']).toBe('manual')
      expect(agent.workspaces['background-thread']).toEqual(workspace)
      // What the send's approval step reads: web search and commands ask.
      expect(resolveMcpAutoApprove('background-thread')).toBe(false)
      expect(resolveExecAutoApprove('background-thread')).toBe(false)
      // New Chat is done with them, as after a direct send.
      expect(agent.approvalModes[TEMPORARY_CHAT_ID]).toBeUndefined()
      expect(agent.workspaces[TEMPORARY_CHAT_ID]).toBeUndefined()
    })

    it('keeps the mode from Send even if New Chat was switched since, and leaves that new pick', async () => {
      // Full access at Send; back on New Chat later the user picked
      // Restricted for their next chat.
      useAgentMode.setState({
        approvalModes: { [TEMPORARY_CHAT_ID]: 'manual' },
      })

      await sendAfterLeaving({ approvalMode: 'skip' })

      const agent = useAgentMode.getState()
      expect(agent.approvalModes['background-thread']).toBe('skip')
      expect(resolveExecAutoApprove('background-thread')).toBe(true)
      expect(agent.approvalModes[TEMPORARY_CHAT_ID]).toBe('manual')
    })

    it('leaves an untouched mode untouched, so the chat follows the global switch like a direct send', async () => {
      await sendAfterLeaving({})

      expect(
        useAgentMode.getState().approvalModes['background-thread']
      ).toBeUndefined()
      expect(resolveMcpAutoApprove('background-thread')).toBe(true)
    })
  })
})
