import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppState } from '@/hooks/useAppState'
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
    usePrompt.setState({ prompt: 'Queued prompt' })
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
})
