import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ChatInput from '../ChatInput'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useModelProvider } from '@/hooks/useModelProvider'
import { usePrompt } from '@/hooks/usePrompt'
import { seedServiceHub } from '@/test/service-hub'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  downscaleImageDataUrl: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ navigate: mocks.navigate }),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/imageDownscale', () => ({
  downscaleImageDataUrl: mocks.downscaleImageDataUrl,
}))

vi.mock('react-textarea-autosize', async () => {
  const React = await import('react')
  type AutosizeProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    minRows?: number
    maxRows?: number
  }
  return {
    default: React.forwardRef<HTMLTextAreaElement, AutosizeProps>(
      ({ minRows, maxRows, ...props }, ref) => {
        void minRows
        void maxRows
        return <textarea {...props} ref={ref} />
      }
    ),
  }
})

vi.mock('@/hooks/useTools', () => ({
  useTools: vi.fn(),
}))

vi.mock('@/hooks/useAgentSkills', () => ({
  useAgentSkills: () => ({ skills: [], loading: false }),
}))

vi.mock('@/hooks/useAgentMode', () => {
  const state = {
    agentThreads: {},
    approvalModes: {},
    setAgentMode: vi.fn(),
    setApprovalMode: vi.fn(),
  }
  const useAgentMode = (selector: (value: typeof state) => unknown) =>
    selector(state)
  useAgentMode.getState = () => state
  return { useAgentMode }
})

vi.mock('@/hooks/useJanBrowserExtension', () => ({
  useJanBrowserExtension: () => ({
    isActive: false,
    dialogOpen: false,
    dialogState: null,
    toggleBrowser: vi.fn(),
    handleCancel: vi.fn(),
    setDialogOpen: vi.fn(),
  }),
}))

vi.mock('@/containers/chatInput/useTauriDragDrop', () => ({
  useTauriDragDrop: vi.fn(),
}))

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({ get: () => undefined }),
  },
}))

vi.mock('@/containers/DropdownToolsAvailable', () => ({
  // A marker instead of null: the toolbar asserts the tools button is there.
  default: () => <span data-test-id="tools-dropdown" />,
}))

vi.mock('@/containers/VoiceInputToggle', () => ({
  // A marker rather than null: the composer's placement of the microphone is
  // asserted below, and that needs something in the DOM to locate.
  default: () => <button data-test-id="voice-input-toggle" />,
}))

vi.mock('@/containers/chatInput/VoiceRecordingBar', () => ({
  default: () => null,
}))

vi.mock('@/containers/ReasoningToggle', () => ({
  // A marker rather than null: its place in the right-hand cluster is asserted.
  default: () => <button data-test-id="reasoning-toggle" />,
}))

vi.mock('@/containers/dialogs/JanBrowserExtensionDialog', () => ({
  default: () => null,
}))

vi.mock('@/containers/PromptVisionModel', () => ({
  PromptVisionModel: () => null,
}))

vi.mock('@/containers/AgentApprovalModeSelect', () => ({
  AgentApprovalModeSelect: () => null,
}))

vi.mock('@/containers/AgentExternalFolderButton', () => ({
  AgentExternalFolderButton: () => null,
}))

vi.mock('@/components/TokenCounter', () => ({
  TokenCounter: () => null,
}))

describe('ChatInput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedServiceHub()
    usePrompt.setState({ prompt: '' })
    useChatAttachments.setState({ attachmentsByThread: {} })

    const model = {
      id: 'test-model',
      capabilities: [],
      settings: {},
    } as Model
    const provider = {
      provider: 'openai',
      active: true,
      models: [model],
      settings: [],
    } as ModelProvider
    useModelProvider.setState({
      providers: [provider],
      selectedProvider: 'openai',
      selectedModel: model,
    })
  })

  it('renders the production input with its translated placeholder', () => {
    const { unmount } = render(<ChatInput />)

    expect(screen.getByTestId('chat-input')).toHaveAttribute(
      'placeholder',
      'common:placeholder.chatInput'
    )
    expect(
      document.querySelector('[data-test-id="send-message-button"]')
    ).toBeDisabled()
    unmount()
  })

  it('puts reasoning and the microphone beside Send', () => {
    const { unmount } = render(<ChatInput />)

    const reasoning = document.querySelector(
      '[data-test-id="reasoning-toggle"]'
    )
    const mic = document.querySelector('[data-test-id="voice-input-toggle"]')
    const send = document.querySelector('[data-test-id="send-message-button"]')
    expect(reasoning).toBeInTheDocument()
    expect(mic).toBeInTheDocument()
    expect(send).toBeInTheDocument()

    // One cluster on the right...
    expect(reasoning!.parentElement).toBe(send!.parentElement)
    expect(mic!.parentElement).toBe(send!.parentElement)
    // ...reading [reasoning] [mic] [send].
    expect(
      reasoning!.compareDocumentPosition(mic!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      mic!.compareDocumentPosition(send!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    unmount()
  })

  it('submits entered text and clears the controlled prompt', async () => {
    const onSubmit = vi.fn()
    const { unmount } = render(<ChatInput onSubmit={onSubmit} />)
    const input = screen.getByTestId('chat-input')
    const sendButton = document.querySelector(
      '[data-test-id="send-message-button"]'
    )

    fireEvent.change(input, { target: { value: 'Invoke the machine spirit' } })

    expect(input).toHaveValue('Invoke the machine spirit')
    expect(sendButton).toBeEnabled()
    fireEvent.click(sendButton!)

    expect(onSubmit).toHaveBeenCalledWith(
      'Invoke the machine spirit',
      undefined,
      undefined
    )
    await waitFor(() => expect(input).toHaveValue(''))
    unmount()
  })

  it('asks for a model instead of sending when none is selected', async () => {
    // With model preloading off by default, this is the state of every cold
    // launch until the user picks a model in the selector.
    useModelProvider.setState({ selectedProvider: '', selectedModel: null })
    const onSubmit = vi.fn()
    const { unmount } = render(<ChatInput onSubmit={onSubmit} />)
    const input = screen.getByTestId('chat-input')

    fireEvent.change(input, { target: { value: 'Invoke the machine spirit' } })
    fireEvent.click(
      document.querySelector('[data-test-id="send-message-button"]')!
    )

    expect(await screen.findByText('chat:selectModelToChat')).toBeVisible()
    expect(onSubmit).not.toHaveBeenCalled()
    // The typed prompt survives so the user can send it once a model is picked.
    expect(input).toHaveValue('Invoke the machine spirit')
    unmount()
  })

  it('keeps the tools and web search controls before a model is picked', () => {
    // A composer stripped down to a plus button reads as broken; the real
    // `tools` capability only starts gating once a model is actually selected.
    useMCPServers.setState({
      mcpServers: {
        exa: { command: '', args: [], env: {}, active: false },
      },
    })
    useModelProvider.setState({ selectedProvider: '', selectedModel: null })

    const { unmount } = render(<ChatInput />)

    expect(
      document.querySelector('[data-test-id="tools-dropdown"]')
    ).toBeInTheDocument()
    expect(
      screen.getByLabelText('common:webSearchToggleDisabled')
    ).toBeInTheDocument()

    useMCPServers.setState({ mcpServers: {} })
    unmount()
  })

  it('downscales an image before applying the byte limit', async () => {
    const model = {
      id: 'vision-model',
      capabilities: ['vision'],
      settings: {},
    } as Model
    useModelProvider.setState({
      providers: [
        {
          provider: 'openai',
          active: true,
          models: [model],
          settings: [],
        } as ModelProvider,
      ],
      selectedProvider: 'openai',
      selectedModel: model,
    })
    mocks.downscaleImageDataUrl.mockResolvedValue({
      dataUrl: 'data:image/jpeg;base64,dGVzdA==',
      base64: 'dGVzdA==',
      mimeType: 'image/jpeg',
      size: 4,
    })

    render(<ChatInput />)
    const file = new File(['test'], 'camera.jpg', { type: 'image/jpeg' })
    Object.defineProperty(file, 'size', { value: 11 * 1024 * 1024 })

    fireEvent.paste(screen.getByTestId('chat-input'), {
      clipboardData: {
        items: [
          {
            type: 'image/jpeg',
            getAsFile: () => file,
          },
        ],
      },
    })

    await waitFor(() => {
      expect(useChatAttachments.getState().getAttachments()).toEqual([
        expect.objectContaining({
          name: 'camera.jpg',
          mimeType: 'image/jpeg',
          size: 4,
          base64: 'dGVzdA==',
        }),
      ])
    })
  })
})
