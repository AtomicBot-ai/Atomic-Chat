import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import posthog from 'posthog-js'
import type { ChatInit, UIMessage } from 'ai'

import { defaultAssistant } from '@/hooks/useAssistant'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { captureChatResponse, currentChatTurn } from '@/lib/chat-telemetry'
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
  // The options of the provider's latest `useChat` render: what the shared
  // Chat calls back into.
  chat: undefined as
    | Pick<ChatInit<UIMessage>, 'onError' | 'onFinish'>
    | undefined,
}))

vi.mock('posthog-js', () => ({
  // `queuedCapture` sends straight away once capturing is opted in.
  default: { capture: vi.fn(), has_opted_in_capturing: () => true },
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('@/utils/switchModel', () => ({
  switchToModel: mocks.switchToModel,
}))

vi.mock('@/hooks/use-chat', () => ({
  useChat: (options: Pick<ChatInit<UIMessage>, 'onError' | 'onFinish'>) => {
    mocks.chat = options
    return {
      sendMessage: mocks.sendMessage,
      addToolOutput: mocks.addToolOutput,
    }
  },
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

  it('sends a released project queue while New Chat is open and preserves the project draft scope', async () => {
    window.history.replaceState({}, '', '/')
    const project = { id: 'qa-project', name: 'QA project', updated_at: 1 }
    const assistant = {
      ...defaultAssistant,
      id: 'qa-assistant',
      instructions: 'Answer with a number.',
    }
    usePrompt.getState().setDraft('project:qa-project', 'What is 19 times 7?')
    usePrompt.getState().setDraft(TEMPORARY_CHAT_ID, 'Unrelated home draft')
    useDeferredFirstSend.getState().enqueue({
      id: 'project-queue',
      prompt: 'What is 19 times 7?',
      downloadModelIds: ['owner/model'],
      createdAt: Date.now(),
      project,
      assistant,
      composerKey: 'project:qa-project',
    })
    useDeferredFirstSend.getState().claim('project-queue')
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
    render(<DeferredFirstSendProvider />)
    expect(mocks.switchToModel).not.toHaveBeenCalled()
    act(() => useDeferredFirstSend.getState().release('project-queue'))
    await waitFor(() => expect(mocks.switchToModel).toHaveBeenCalled())
    act(() => useAppState.setState({ activeModels: ['owner/model'] }))
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1))
    expect(mocks.createThread).toHaveBeenCalledWith(
      { id: 'owner/model', provider: 'llamacpp-upstream' },
      'What is 19 times 7?',
      assistant,
      project
    )
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [{ type: 'text', text: 'What is 19 times 7?' }],
      })
    )
    expect(usePrompt.getState().getDraft('project:qa-project')).toBe('')
    expect(usePrompt.getState().getDraft(TEMPORARY_CHAT_ID)).toBe(
      'Unrelated home draft'
    )
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(useDeferredFirstSend.getState().queued).toBeNull()
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

  const armHomeSend = (claimed: boolean) =>
    act(() => {
      useDeferredFirstSend.getState().enqueue({
        id: 'queue-home',
        prompt: 'Queued prompt',
        downloadModelIds: ['owner/model'],
        createdAt: Date.now(),
      })
      // New Chat's composer claims what it completes itself (ChatInput).
      if (claimed) useDeferredFirstSend.getState().claim('queue-home')
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
        selectedProvider: 'llamacpp-upstream',
        selectedModel: {
          id: 'owner/model',
          capabilities: [],
          settings: {},
        } as unknown as Model,
      })
      useAppState.setState({ activeModels: ['owner/model'] })
    })

  it('leaves the send to New Chat while its composer has claimed it', async () => {
    // The composer selected and started the model and sends the message
    // itself; a second thread from here would send it twice.
    window.history.replaceState({}, '', '/')
    render(<DeferredFirstSendProvider />)
    armHomeSend(true)

    await act(async () => {})
    expect(mocks.createThread).not.toHaveBeenCalled()
    expect(usePrompt.getState().prompt).toBe('Queued prompt')
    expect(useDeferredFirstSend.getState().queued?.id).toBe('queue-home')
  })

  it('takes over once New Chat lets go of the claim', async () => {
    window.history.replaceState({}, '', '/')
    render(<DeferredFirstSendProvider />)
    armHomeSend(true)
    await act(async () => {})

    act(() => useDeferredFirstSend.getState().release('queue-home'))
    await act(async () => {})

    expect(mocks.createThread).toHaveBeenCalledTimes(1)
    expect(useDeferredFirstSend.getState().queued).toBeNull()
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

  // The onboarding funnel counts "reached a first request" on
  // `chat_request_sent`; a first message sent here, after its model finished
  // downloading, is that first request.
  describe('chat telemetry', () => {
    const events = (name: string) =>
      vi
        .mocked(posthog.capture)
        .mock.calls.filter(([event]) => event === name)
        .map(([, props]) => props as Record<string, unknown>)

    const userMessage: UIMessage = {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Queued prompt' }],
    }
    const reply = (metadata: Record<string, unknown> = {}): UIMessage => ({
      id: 'reply-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Hello! How can I help?' }],
      metadata,
    })
    const finish = (
      message: UIMessage,
      flags: { isAbort?: boolean; isError?: boolean } = {}
    ) =>
      act(() => {
        mocks.chat!.onFinish!({
          message,
          messages: [userMessage, message],
          isAbort: false,
          isDisconnect: false,
          isError: false,
          ...flags,
        })
      })

    const sendInBackground = async (ctxLen?: number) => {
      render(<DeferredFirstSendProvider />)
      act(() => {
        useDeferredFirstSend.getState().enqueue({
          id: 'queue-telemetry',
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
                {
                  id: 'owner/model',
                  capabilities: [],
                  settings: ctxLen
                    ? { ctx_len: { controller_props: { value: ctxLen } } }
                    : {},
                } as Model,
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
      useGeneralSetting.setState({
        agentModeEnabled: false,
        legacyChatEngine: false,
      })
      useAppState.setState({
        ragToolNames: new Set(),
        mcpToolNames: new Set(),
        toolCostReports: {},
      })
    })

    it('reports the background send as one chat request, paired with its reply', async () => {
      await sendInBackground()

      const requests = events('chat_request_sent')
      expect(requests).toHaveLength(1)
      expect(requests[0]).toEqual({
        turn_id: expect.any(String),
        thread_id: 'background-thread',
        source: 'chat',
        engine: 'chat-transport',
        route_reason: 'default-chat',
        model_id: 'owner/model',
        provider: 'llamacpp-upstream',
        backend: 'llamacpp-upstream',
        turn_index: 0,
        prompt_len_bucket: 'lt_100',
        is_agent_mode: false,
        agent_skill: null,
        attachment_count: 0,
        attachment_kinds: [],
        attachment_exts: [],
        attachment_size_bucket: 'unknown',
        parse_modes: [],
        injection_modes: [],
        chunk_count_total: 0,
        has_attachments: false,
        ctx_len: null,
        ctx_used_pct_bucket: 'unknown',
        tools_enabled_count: 0,
        has_rag: false,
        has_mcp: false,
        tools_tokens_estimate: null,
        tools_ctx_share: null,
        tools_heavy_servers: 0,
      })
      // Nothing comes back until the reply finishes.
      expect(events('chat_response_received')).toHaveLength(0)

      finish(
        reply({
          finishReason: 'stop',
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        })
      )
      // `onFinish` can fire again for the same message.
      finish(reply({ finishReason: 'stop' }))

      const responses = events('chat_response_received')
      expect(responses).toHaveLength(1)
      expect(responses[0]).toMatchObject({
        turn_id: requests[0].turn_id,
        thread_id: 'background-thread',
        source: 'chat',
        engine: 'chat-transport',
        route_reason: 'default-chat',
        outcome: 'success',
        finish_reason: 'stop',
        model_id: 'owner/model',
        provider: 'llamacpp-upstream',
        turn_index: 2,
        response_len_bucket: 'lt_100',
        tokens_total: 20,
        attachment_count: 0,
        ctx_overflow: false,
        ctx_auto_increased: false,
        error_kind: null,
      })
      expect(events('chat_request_sent')).toHaveLength(1)
    })

    it('leaves the reply to the thread page when that page was open at the finish', async () => {
      await sendInBackground()
      const [request] = events('chat_request_sent')

      // The thread page owned the Chat's callbacks when the reply landed and
      // reported it under the in-flight turn, as its `captureTurnOutcome` does.
      captureChatResponse({
        turn_id: currentChatTurn('background-thread'),
        thread_id: 'background-thread',
        source: 'chat',
        outcome: 'success',
      })
      finish(reply({ finishReason: 'stop' }))

      const responses = events('chat_response_received')
      expect(responses).toHaveLength(1)
      expect(responses[0].turn_id).toBe(request.turn_id)
    })

    it('reports a failed background send once, as an error', async () => {
      await sendInBackground()
      const [request] = events('chat_request_sent')

      act(() => {
        mocks.chat!.onError!(new Error('upstream exploded'))
      })
      finish(reply(), { isError: true })

      const responses = events('chat_response_received')
      expect(responses).toHaveLength(1)
      expect(responses[0]).toMatchObject({
        turn_id: request.turn_id,
        outcome: 'error',
        error_kind: expect.any(String),
      })
      expect(mocks.toastError).toHaveBeenCalledWith(
        'chat:replyGate.backgroundFailed'
      )
    })

    it('reports a stopped reply as aborted', async () => {
      await sendInBackground()

      finish(reply(), { isAbort: true })

      expect(events('chat_response_received')).toEqual([
        expect.objectContaining({ outcome: 'aborted' }),
      ])
    })

    it('reports a reply cut off at the context limit as stopped, since nothing here continues it', async () => {
      await sendInBackground(4096)
      expect(events('chat_request_sent')[0]).toMatchObject({ ctx_len: 4096 })

      finish(
        reply({
          finishReason: 'length',
          usage: { inputTokens: 96, outputTokens: 4000, totalTokens: 4096 },
        })
      )

      expect(events('chat_response_received')).toEqual([
        expect.objectContaining({
          outcome: 'truncated_stopped',
          ctx_len: 4096,
          ctx_overflow: true,
        }),
      ])
    })
  })
})
