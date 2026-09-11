import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ChatInput from '../ChatInput'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useModelProvider } from '@/hooks/useModelProvider'
import { modelStopKey, useAppState } from '@/hooks/useAppState'
import { usePrompt } from '@/hooks/usePrompt'
import { seedServiceHub } from '@/test/service-hub'
import type { ServiceHub } from '@/services'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  downscaleImageDataUrl: vi.fn(),
  switchToModel: vi.fn(),
  chatBusy: false,
  replyGateProps: null as {
    onResolved: (resolution: unknown) => void
    onDismissed: (resolution: unknown) => void
  } | null,
}))

vi.mock('@/utils/switchModel', () => ({
  switchToModel: mocks.switchToModel,
  shouldAttemptAutoStart: () => true,
  isExplicitSwitchPending: () => false,
}))

vi.mock('@/stores/chat-session-store', () => ({
  isAnyChatBusy: () => mocks.chatBusy,
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
  useAgentSkills: () => ({ skills: [], loading: false, setEnabled: vi.fn() }),
}))

vi.mock('@/hooks/useAgentMode', () => {
  const state = {
    approvalModes: {},
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

// Render menus inline so the attach-menu items are queryable without
// driving Radix pointer events through jsdom.
vi.mock('@/components/ui/dropdown-menu', async () => {
  const React = await import('react')
  type WithChildren = { children?: React.ReactNode }
  const passthrough = ({ children }: WithChildren) => <div>{children}</div>
  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuItem: ({
      children,
      onClick,
      ...props
    }: WithChildren & { onClick?: () => void }) => (
      <button onClick={onClick} {...props}>
        {children}
      </button>
    ),
  }
})

vi.mock('@/containers/DropdownPlugins', () => ({
  // A marker instead of null: the toolbar asserts the plugins button is there.
  default: () => <span data-test-id="connectors-dropdown" />,
}))

vi.mock('@/containers/VoiceInputToggle', () => ({
  // A marker rather than null: the composer's placement of the microphone is
  // asserted below, and that needs something in the DOM to locate.
  default: () => <button data-test-id="voice-input-toggle" />,
}))

vi.mock('@/containers/chatInput/VoiceRecordingBar', () => ({
  default: () => null,
}))

vi.mock('@/containers/DropdownModelProvider', () => ({
  // The model pill; likewise only its place in the cluster matters here.
  default: () => <button data-test-id="model-picker-trigger" />,
}))

vi.mock('@/containers/dialogs/JanBrowserExtensionDialog', () => ({
  default: () => null,
}))

vi.mock('@/containers/PromptVisionModel', () => ({
  PromptVisionModel: () => null,
}))

// Stubbed to a marker that also hands the composer's callbacks back to the
// test: the widget's own suite covers its branches, and its real body fetches
// the recommended model's card from Hugging Face.
vi.mock('@/containers/ReplyModelGate', () => ({
  ReplyModelGate: (props: {
    open: boolean
    onResolved: (resolution: unknown) => void
    onDismissed: (resolution: unknown) => void
  }) => {
    mocks.replyGateProps = props
    return props.open ? <div data-testid="reply-model-gate" /> : null
  },
}))

vi.mock('@/containers/AgentApprovalModeSelect', () => ({
  // A marker: the project-composer test asserts the agent affordances render.
  AgentApprovalModeSelect: () => <span data-test-id="approval-mode-select" />,
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
    useGeneralSetting.setState({ connectorsPinned: true, agentModeEnabled: false })

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

  it('puts the model and the microphone beside Send', () => {
    const { unmount } = render(<ChatInput />)

    const model = document.querySelector(
      '[data-test-id="model-picker-trigger"]'
    )
    const mic = document.querySelector('[data-test-id="voice-input-toggle"]')
    const send = document.querySelector('[data-test-id="send-message-button"]')
    expect(model).toBeInTheDocument()
    expect(mic).toBeInTheDocument()
    expect(send).toBeInTheDocument()

    // One cluster on the right...
    expect(model!.parentElement).toBe(send!.parentElement)
    expect(mic!.parentElement).toBe(send!.parentElement)
    // ...reading [model] [mic] [send], with nothing ahead of the pill: the
    // reasoning bulb is gone, thinking is switched off on the effort slider.
    expect(send!.parentElement!.firstElementChild).toBe(model)
    expect(
      model!.compareDocumentPosition(mic!) & Node.DOCUMENT_POSITION_FOLLOWING
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

  it('opens the reply-model widget instead of sending when none is selected', async () => {
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

    expect(await screen.findByTestId('reply-model-gate')).toBeVisible()
    expect(onSubmit).not.toHaveBeenCalled()
    // The typed prompt survives so it can go out once a model is ready.
    expect(input).toHaveValue('Invoke the machine spirit')
    unmount()
  })

  it('sends the held message by itself once a model can answer', async () => {
    useModelProvider.setState({ selectedProvider: '', selectedModel: null })
    const onSubmit = vi.fn()
    const { unmount } = render(<ChatInput onSubmit={onSubmit} />)
    const input = screen.getByTestId('chat-input')

    fireEvent.change(input, { target: { value: 'Invoke the machine spirit' } })
    fireEvent.click(
      document.querySelector('[data-test-id="send-message-button"]')!
    )
    await screen.findByTestId('reply-model-gate')

    // The widget resolved: something is on its way, but not up yet.
    act(() => {
      mocks.replyGateProps!.onResolved({
        outcome: 'download',
        branch: 'none',
        decidedInMs: 5,
        openedAtMs: Date.now() - 5,
      })
    })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('reply-gate-queued-notice')).toBeVisible()

    // …and now it is. The message goes out unchanged, with nobody pressing
    // anything, and the widget gets out of the way.
    act(() => {
      useModelProvider.setState({
        selectedProvider: 'openai',
        selectedModel: { id: 'test-model', capabilities: [], settings: {} } as Model,
      })
    })

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        'Invoke the machine spirit',
        undefined,
        undefined
      )
    )
    expect(screen.queryByTestId('reply-model-gate')).toBeNull()
    unmount()
  })

  it('drops the held message when the widget is dismissed', async () => {
    useModelProvider.setState({ selectedProvider: '', selectedModel: null })
    const onSubmit = vi.fn()
    const { unmount } = render(<ChatInput onSubmit={onSubmit} />)

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Invoke the machine spirit' },
    })
    fireEvent.click(
      document.querySelector('[data-test-id="send-message-button"]')!
    )
    await screen.findByTestId('reply-model-gate')

    act(() => {
      mocks.replyGateProps!.onDismissed({
        outcome: 'dismissed',
        branch: 'none',
        decidedInMs: 5,
        openedAtMs: Date.now() - 5,
      })
    })
    act(() => {
      useModelProvider.setState({
        selectedProvider: 'openai',
        selectedModel: { id: 'test-model', capabilities: [], settings: {} } as Model,
      })
    })

    // Giving up is not a deferred send: nothing goes out behind the user's
    // back, and the text they typed is still theirs to edit.
    await waitFor(() =>
      expect(screen.queryByTestId('reply-model-gate')).toBeNull()
    )
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('chat-input')).toHaveValue(
      'Invoke the machine spirit'
    )
    unmount()
  })

  it('answers with a connected cloud provider itself, without the widget', async () => {
    // The device already knows what to reply with; asking would be a
    // question with one answer (ATO-461).
    const model = { id: 'gpt-a', capabilities: [], settings: {} } as Model
    useModelProvider.setState({
      providers: [
        {
          provider: 'openai',
          active: true,
          api_key: 'sk-test',
          models: [model],
          settings: [
            {
              key: 'api-key',
              title: 'API key',
              description: '',
              controller_type: 'input',
              controller_props: { value: 'sk-test' },
            },
          ],
        } as ModelProvider,
      ],
      selectedProvider: '',
      selectedModel: null,
    })
    mocks.switchToModel.mockResolvedValue(undefined)
    const onSubmit = vi.fn()
    const { unmount } = render(<ChatInput onSubmit={onSubmit} />)

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Invoke the machine spirit' },
    })
    fireEvent.click(
      document.querySelector('[data-test-id="send-message-button"]')!
    )

    expect(screen.queryByTestId('reply-model-gate')).toBeNull()
    expect(mocks.switchToModel).toHaveBeenCalledWith(
      expect.objectContaining({ providerName: 'openai', modelId: 'gpt-a' })
    )
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        'Invoke the machine spirit',
        undefined,
        undefined
      )
    )
    unmount()
  })

  it('starts the only local model on send and holds the message until it is up', async () => {
    const model = { id: 'Qwen3.5-4B-Q4_K_M', capabilities: [], settings: {} } as Model
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [model],
          settings: [],
        } as ModelProvider,
      ],
      selectedProvider: '',
      selectedModel: null,
    })
    useAppState.setState({ activeModels: [] })
    mocks.switchToModel.mockResolvedValue(undefined)
    const onSubmit = vi.fn()
    const { unmount } = render(<ChatInput onSubmit={onSubmit} />)

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Invoke the machine spirit' },
    })
    fireEvent.click(
      document.querySelector('[data-test-id="send-message-button"]')!
    )

    // No modal: the status lives in the composer, and says which model.
    expect(screen.queryByTestId('reply-model-gate')).toBeNull()
    expect(screen.getByTestId('reply-gate-queued-notice')).toHaveTextContent(
      'chat:replyGate.startingNotice'
    )
    expect(onSubmit).not.toHaveBeenCalled()
    expect(useModelProvider.getState().selectedModel?.id).toBe(model.id)

    // The engine reports it up; the message goes out by itself.
    act(() => {
      useAppState.setState({ activeModels: [model.id] })
    })
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        'Invoke the machine spirit',
        undefined,
        undefined
      )
    )
    unmount()
  })

  it('brings a model the user stopped back up on send, instead of blocking Send', async () => {
    const model = { id: 'Qwen3.5-4B-Q4_K_M', capabilities: [], settings: {} } as Model
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [model],
          settings: [],
        } as ModelProvider,
      ],
      selectedProvider: 'llamacpp-upstream',
      selectedModel: model,
    })
    useAppState.setState({
      activeModels: [],
      loadingModel: false,
      userStoppedModels: [modelStopKey('llamacpp-upstream', model.id)],
    })
    mocks.switchToModel.mockResolvedValue(undefined)
    const onSubmit = vi.fn()
    const { unmount } = render(<ChatInput onSubmit={onSubmit} />)

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Invoke the machine spirit' },
    })
    const send = document.querySelector('[data-test-id="send-message-button"]')!
    // Nothing else is going to start a model the user stopped, so waiting for
    // it to come up would leave Send dead for good.
    expect(send).not.toBeDisabled()
    fireEvent.click(send)

    await waitFor(() =>
      expect(mocks.switchToModel).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: model.id,
          providerName: 'llamacpp-upstream',
        })
      )
    )
    // An explicit start, like a pick in the dropdown — not a silent auto-start.
    expect(mocks.switchToModel.mock.calls[0][0].isAutoStart).toBeUndefined()
    expect(screen.getByTestId('reply-gate-queued-notice')).toHaveTextContent(
      'chat:replyGate.startingNotice'
    )
    expect(onSubmit).not.toHaveBeenCalled()

    act(() => {
      useAppState.setState({ activeModels: [model.id], userStoppedModels: [] })
    })
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        'Invoke the machine spirit',
        undefined,
        undefined
      )
    )
    unmount()
  })

  it('marks Send as needing a model before it is pressed', () => {
    useModelProvider.setState({ selectedProvider: '', selectedModel: null })
    const { unmount } = render(<ChatInput onSubmit={vi.fn()} />)

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Invoke the machine spirit' },
    })

    // The state is on the button itself, so the user learns about it without
    // pressing — the red line only ever appeared afterwards.
    expect(
      document.querySelector('[data-test-id="send-message-button"]')
    ).toHaveAttribute('data-needs-model', 'true')
    unmount()
  })

  // Agent affordances need the global toggle on AND an agent-capable
  // provider: the seeded 'openai' provider has no API key, which would still
  // route to the chat fallback.
  const selectLocalProvider = () => {
    useGeneralSetting.setState({ agentModeEnabled: true })
    const model = { id: 'local-model', capabilities: [], settings: {} } as Model
    const provider = {
      provider: 'llamacpp',
      active: true,
      models: [model],
      settings: [],
    } as ModelProvider
    useModelProvider.setState({
      providers: [provider],
      selectedProvider: 'llamacpp',
      selectedModel: model,
    })
  }

  it('keeps the agent affordances on the project composer but hides Add folder', () => {
    selectLocalProvider()
    const { unmount } = render(
      <ChatInput initialMessage projectId="project-1" />
    )

    // The agent chip proves the project composer routes to the agent engine
    // (the old project gate is gone)...
    expect(
      document.querySelector('[data-testid="agent-mode-chip"]')
    ).toBeInTheDocument()
    // ...while the workspace-folder item stays off this page: it has no
    // files panel to surface the folder in.
    expect(
      screen.queryByText('chat:agentWorkspace.addFolder')
    ).not.toBeInTheDocument()
    unmount()
  })

  it('offers Add folder in the attach menu of a plain composer', () => {
    selectLocalProvider()
    const { unmount } = render(<ChatInput initialMessage />)

    expect(
      screen.getByText('chat:agentWorkspace.addFolder')
    ).toBeInTheDocument()
    unmount()
  })

  it('keeps the connectors and web search controls before a model is picked', () => {
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
      document.querySelector('[data-test-id="connectors-dropdown"]')
    ).toBeInTheDocument()
    expect(
      screen.getByLabelText('common:webSearchToggleDisabled')
    ).toBeInTheDocument()

    useMCPServers.setState({ mcpServers: {} })
    unmount()
  })

  // A model that actually advertises tools: the connectors button and the
  // attach-menu pin toggle both hang off that capability.
  const selectToolCapableModel = () => {
    const model = {
      id: 'tool-model',
      capabilities: ['tools'],
      settings: {},
    } as unknown as Model
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
  }

  it('drops the connectors button from the toolbar once it is unpinned', () => {
    // Unpinning is a UI choice, not a kill switch: it only takes the button
    // out of the toolbar, and the "+" menu is the way back to it.
    useMCPServers.setState({
      mcpServers: {
        exa: { command: '', args: [], env: {}, active: true },
      },
    })
    useGeneralSetting.setState({ connectorsPinned: false })
    selectToolCapableModel()

    const { unmount } = render(<ChatInput />)

    expect(
      document.querySelector('[data-test-id="connectors-dropdown"]')
    ).not.toBeInTheDocument()
    // The server it would have listed is still connected, and web search —
    // which runs on one of those servers — is still on the toolbar.
    expect(useMCPServers.getState().mcpServers.exa.active).toBe(true)
    expect(
      screen.getByLabelText('common:webSearchToggleEnabled')
    ).toBeInTheDocument()

    useMCPServers.setState({ mcpServers: {} })
    unmount()
  })

  it('pins and unpins the plugins button from the attach menu', () => {
    selectToolCapableModel()

    const { unmount } = render(<ChatInput />)

    fireEvent.click(screen.getByText('plugins'))
    expect(useGeneralSetting.getState().connectorsPinned).toBe(false)
    expect(
      document.querySelector('[data-test-id="connectors-dropdown"]')
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('plugins'))
    expect(useGeneralSetting.getState().connectorsPinned).toBe(true)
    expect(
      document.querySelector('[data-test-id="connectors-dropdown"]')
    ).toBeInTheDocument()

    unmount()
  })

  it('keeps the agent controls while no provider is resolved yet, if agent mode is on', () => {
    // The provider list loads asynchronously at boot and no model is picked on
    // a cold launch: routing says "chat transport" only because it has nothing
    // to judge, and a composer the user switched to Agent mode must not shed
    // its agent controls meanwhile.
    useGeneralSetting.setState({ agentModeEnabled: true })
    useModelProvider.setState({
      providers: [],
      selectedProvider: '',
      selectedModel: null,
    })

    const { unmount } = render(<ChatInput initialMessage />)

    expect(
      document.querySelector('[data-test-id="approval-mode-select"]')
    ).toBeInTheDocument()
    expect(
      document.querySelector('[data-testid="agent-mode-chip"]')
    ).toBeInTheDocument()
    expect(
      screen.getByText('chat:agentWorkspace.addFolder')
    ).toBeInTheDocument()
    unmount()
  })

  it('shows the plain chat composer by default even on an agent-capable provider', () => {
    // Chat is the default engine: with the global toggle off, an agent-capable
    // local provider still gets the chat placeholder and no agent controls.
    const model = { id: 'local-model', capabilities: [], settings: {} } as Model
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp',
          active: true,
          models: [model],
          settings: [],
        } as ModelProvider,
      ],
      selectedProvider: 'llamacpp',
      selectedModel: model,
    })

    const { unmount } = render(<ChatInput initialMessage />)

    expect(screen.getByTestId('chat-input')).toHaveAttribute(
      'placeholder',
      'common:placeholder.chatInput'
    )
    // The approval select stays in the toolbar for both engines — it governs
    // chat MCP/RAG calls too — but the agent chip only shows with the toggle.
    expect(
      document.querySelector('[data-test-id="approval-mode-select"]')
    ).toBeInTheDocument()
    expect(
      document.querySelector('[data-testid="agent-mode-chip"]')
    ).not.toBeInTheDocument()
    unmount()
  })

  it('toggles the global agent mode from the attach menu', () => {
    const { unmount } = render(<ChatInput />)

    fireEvent.click(screen.getByText('chat:agentMode.menuItem'))
    expect(useGeneralSetting.getState().agentModeEnabled).toBe(true)

    fireEvent.click(screen.getByText('chat:agentMode.menuItem'))
    expect(useGeneralSetting.getState().agentModeEnabled).toBe(false)
    unmount()
  })

  it('renders the agent chip whose X turns the mode off everywhere', () => {
    selectLocalProvider()

    const { unmount } = render(<ChatInput initialMessage />)

    expect(
      document.querySelector('[data-testid="agent-mode-chip"]')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('chat:agentMode.turnOff'))
    expect(useGeneralSetting.getState().agentModeEnabled).toBe(false)
    expect(
      document.querySelector('[data-testid="agent-mode-chip"]')
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-input')).toHaveAttribute(
      'placeholder',
      'common:placeholder.chatInput'
    )
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

describe('ChatInput local model auto-start', () => {
  const localModel = {
    id: 'shared-model',
    capabilities: [],
    settings: {},
  } as Model
  const upstream = {
    provider: 'llamacpp-upstream',
    active: true,
    models: [localModel],
    settings: [],
  } as ModelProvider

  function seedModels(activeByProvider: Record<string, string[]>) {
    const getActiveModels = vi.fn(async (provider?: string) =>
      provider
        ? (activeByProvider[provider] ?? [])
        : [...new Set(Object.values(activeByProvider).flat())]
    )
    const stopAllModelsExcept = vi.fn().mockResolvedValue(undefined)
    seedServiceHub({
      models: {
        getActiveModels,
        stopAllModelsExcept,
      } as unknown as ReturnType<ServiceHub['models']>,
    })
    return { getActiveModels, stopAllModelsExcept }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.chatBusy = false
    mocks.switchToModel.mockResolvedValue(undefined)
    usePrompt.setState({ prompt: '' })
    useChatAttachments.setState({ attachmentsByThread: {} })
    useGeneralSetting.setState({ connectorsPinned: true, agentModeEnabled: false })
    useModelProvider.setState({
      providers: [upstream],
      selectedProvider: 'llamacpp-upstream',
      selectedModel: localModel,
    })
  })

  it('drops a stray copy in another engine instead of switching', async () => {
    const { stopAllModelsExcept } = seedModels({
      'llamacpp-upstream': ['shared-model'],
      llamacpp: ['shared-model'],
    })
    const { unmount } = render(<ChatInput />)

    await waitFor(() => {
      expect(stopAllModelsExcept).toHaveBeenCalledWith(
        'shared-model',
        'llamacpp-upstream'
      )
    })
    expect(mocks.switchToModel).not.toHaveBeenCalled()
    unmount()
  })

  it('auto-starts when the selected engine does not serve the model', async () => {
    seedModels({})
    const { unmount } = render(<ChatInput />)

    await waitFor(() => {
      expect(mocks.switchToModel).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: 'shared-model',
          providerName: 'llamacpp-upstream',
          isAutoStart: true,
        })
      )
    })
    unmount()
  })

  it('never touches the engines while this thread is streaming', async () => {
    const { getActiveModels, stopAllModelsExcept } = seedModels({
      'llamacpp-upstream': ['shared-model'],
      llamacpp: ['shared-model'],
    })
    const { unmount } = render(<ChatInput chatStatus="streaming" />)

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getActiveModels).not.toHaveBeenCalled()
    expect(stopAllModelsExcept).not.toHaveBeenCalled()
    expect(mocks.switchToModel).not.toHaveBeenCalled()
    unmount()
  })

  it('never touches the engines while another chat is busy', async () => {
    mocks.chatBusy = true
    const { getActiveModels } = seedModels({})
    const { unmount } = render(<ChatInput />)

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getActiveModels).not.toHaveBeenCalled()
    expect(mocks.switchToModel).not.toHaveBeenCalled()
    unmount()
  })
})
